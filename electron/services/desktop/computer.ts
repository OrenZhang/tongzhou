import { desktopCapturer, systemPreferences, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { command } from '../../core/tools/workspace';
import type { ComputerAdapter } from '../../core/tools/extensions';
import { x11Available, x11Run, rgbaToPng, type X11Capture } from './linux-computer';
import type { ComputerStatus, ToolOutput } from '../../../src/shared/types';
import type { ToolSpec } from '../../core/models/providers';

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const number = { type: 'number' };
const frame = { frameId: string };
export const computerTools: ToolSpec[] = [
  {
    name: 'computer_windows',
    description: '列出可操作的桌面窗口。每次操作需用户批准；不要访问或绕过凭据、验证码与系统保护。',
    parameters: schema({}),
  },
  {
    name: 'computer_screenshot',
    description:
      '获取指定窗口截图，返回 frameId 与图片坐标。截图会发送给当前会话模型。操作前必须观察最新截图。',
    parameters: schema({ windowId: string }, ['windowId']),
  },
  {
    name: 'computer_click',
    description: '在最近截图的图片坐标点击窗口。一次点击后重新截图检查。',
    parameters: schema(
      {
        ...frame,
        x: number,
        y: number,
        button: { type: 'string', enum: ['left', 'right'] },
        clickCount: { type: 'integer', enum: [1, 2] },
      },
      ['frameId', 'x', 'y'],
    ),
  },
  {
    name: 'computer_type',
    description:
      '向截图对应窗口输入文本，不自动提交。frameId 仅可使用一次，点击后需重新截图再输入。不得输入密码或验证码。',
    parameters: schema({ ...frame, text: string }, ['frameId', 'text']),
  },
  {
    name: 'computer_key',
    description:
      '按一个键或组合键。例如 CTRL+C、CMD+A、ENTER、TAB、ESC、LEFT。会聚焦截图对应窗口。frameId 仅可使用一次；每次操作后重新截图。',
    parameters: schema({ ...frame, key: string }, ['frameId', 'key']),
  },
  {
    name: 'computer_scroll',
    description: '在截图中的位置滚动窗口。正值向下，负值向上。',
    parameters: schema(
      { ...frame, x: number, y: number, amount: { type: 'integer', minimum: -10, maximum: 10 } },
      ['frameId', 'x', 'y', 'amount'],
    ),
  },
  {
    name: 'computer_drag',
    description: '在同一个窗口内拖动，坐标来自最近截图。',
    parameters: schema({ ...frame, x: number, y: number, toX: number, toY: number }, [
      'frameId',
      'x',
      'y',
      'toX',
      'toY',
    ]),
  },
];
export const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('click'),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['left', 'right']).default('left'),
    clickCount: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(4000) }),
  z.object({
    action: z.literal('key'),
    key: z
      .string()
      .regex(
        /^(?:(?:CTRL|ALT|SHIFT|CMD)\+){0,3}(?:[A-Z0-9]|ENTER|TAB|ESC|BACKSPACE|DELETE|SPACE|LEFT|RIGHT|UP|DOWN|HOME|END|PAGEUP|PAGEDOWN|F[1-9]|F1[0-2])$/,
      ),
  }),
  z.object({
    action: z.literal('scroll'),
    x: z.number().finite(),
    y: z.number().finite(),
    amount: z.number().int().min(-10).max(10),
  }),
  z.object({
    action: z.literal('drag'),
    x: z.number().finite(),
    y: z.number().finite(),
    toX: z.number().finite(),
    toY: z.number().finite(),
  }),
]);
export function mapPoint(
  x: number,
  y: number,
  frame: {
    width: number;
    height: number;
    bounds: { x: number; y: number; width: number; height: number };
  },
) {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new Error('坐标超出截图范围');
  return {
    x: Math.round(frame.bounds.x + (x * frame.bounds.width) / frame.width),
    y: Math.round(frame.bounds.y + (y * frame.bounds.height) / frame.height),
  };
}
type WindowInfo = {
  id: string;
  title: string;
  pid: number;
  ownerId?: string;
  enabled?: boolean;
  className?: string;
  bounds: { x: number; y: number; width: number; height: number };
  clientBounds?: { x: number; y: number; width: number; height: number };
};
export function observedWindow(windows: WindowInfo[], id: string): WindowInfo {
  let target = windows.find((w) => w.id === id);
  if (!target) throw new Error('窗口已关闭，请重新列出窗口');
  const visited = new Set<string>();
  while (target.enabled === false) {
    visited.add(target.id);
    const modal = windows.find(
      (w) => w.ownerId === target!.id && w.pid === target!.pid && !visited.has(w.id),
    );
    if (!modal) throw new Error('目标窗口被弹窗阻挡，请重新列出窗口并观察弹窗；不要猜测点击位置');
    target = modal;
  }
  return target;
}
type Frame = {
  window: WindowInfo;
  width: number;
  height: number;
  bounds: WindowInfo['bounds'];
  expires: number;
};
export class DesktopComputer implements ComputerAdapter {
  private frames = new Map<string, Frame>();
  constructor(private lock = { busy: false }) {}
  fork() {
    return new DesktopComputer(this.lock);
  }
  emergencyShortcut = false;
  status(): ComputerStatus {
    return {
      supported:
        process.platform === 'linux'
          ? x11Available()
          : ['win32', 'darwin'].includes(process.platform),
      platform: process.platform,
      screen:
        process.platform === 'darwin'
          ? systemPreferences.getMediaAccessStatus('screen')
          : 'available',
      accessibility:
        process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false),
      emergencyShortcut: this.emergencyShortcut,
    };
  }
  requestPermission() {
    if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true);
    return this.status();
  }
  specs(readOnly: boolean) {
    return computerTools.filter((_, i) => !readOnly || i < 2);
  }
  private async helper(payload: unknown, signal: AbortSignal) {
    if (process.platform === 'linux') {
      signal.throwIfAborted();
      try {
        return await x11Run(payload, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Could not focus'))
          throw new Error(
            '无法聚焦目标窗口。请将同舟置于前台批准操作，或先点击目标窗口使其获得键盘焦点后重试。未发送输入。',
          );
        if (message.includes('focus was lost'))
          throw new Error(
            '输入过程中目标窗口失去了键盘焦点，字符可能未完整送入。请重新截图确认，必要时先点击目标窗口再输入。',
          );
        throw new Error('电脑操作失败，请检查系统权限与目标窗口状态。');
      }
    }
    const root = path
      .join(__dirname, '../build/computer')
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    const json = JSON.stringify(payload);
    const windowsCode =
      process.platform === 'win32'
        ? (await readFile(path.join(root, 'windows.ps1'), 'utf8')).replace(
            'param([string]$PayloadBase64)',
            "$PayloadBase64 = '" + Buffer.from(json).toString('base64') + "'",
          )
        : '';
    const output =
      process.platform === 'win32'
        ? await command(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-OutputFormat',
              'Text',
              '-EncodedCommand',
              Buffer.from(windowsCode, 'utf16le').toString('base64'),
            ],
            root,
            signal,
            30000,
          )
        : await command(
            '/usr/bin/osascript',
            ['-l', 'JavaScript', path.join(root, 'macos.js'), json],
            root,
            signal,
            30000,
          );
    if (!output.startsWith('exit code: 0\n')) {
      if (output.includes('Could not focus'))
        throw new Error(
          '无法聚焦目标窗口。请将同舟置于前台批准操作，或手动激活目标窗口后重试。未发送输入。',
        );
      if (output.includes('Windows blocked input'))
        throw new Error('系统拒绝向此窗口输入。不支持管理员或受保护窗口。');
      throw new Error('电脑操作失败，请检查系统权限与目标窗口状态。');
    }
    return JSON.parse(output.slice('exit code: 0\n'.length).trim());
  }
  async execute(name: string, args: any, signal: AbortSignal): Promise<ToolOutput> {
    if (!this.status().supported)
      throw new Error('电脑控制需要 Windows、macOS，或带 X11/XWayland 显示的 Linux');
    const platform = this.status().platform;
    if (this.lock.busy) throw new Error('另一项电脑操作正在执行，请稍后重试');
    this.lock.busy = true;
    try {
      signal.throwIfAborted();
      if (name === 'computer_windows') {
        const windows = await this.helper({ action: 'windows' }, signal);
        return { text: JSON.stringify(windows) };
      }
      if (name === 'computer_screenshot') {
        const { windowId } = z.object({ windowId: z.string().max(80) }).parse(args);
        if (this.status().screen === 'denied')
          throw new Error('请在 macOS 系统设置授予同舟屏幕录制权限后重启');
        const windows: WindowInfo[] = await this.helper({ action: 'windows' }, signal);
        const window = observedWindow(windows, windowId);
        let source: Awaited<ReturnType<typeof desktopCapturer.getSources>>[number] | undefined;
        // A newly shown window may be enumerated before its first capture frame exists.
        // Retry only the requested window; never substitute another window or a full screen.
        // Linux skips desktopCapturer entirely: on Wayland sessions it hangs waiting for
        // the capture portal and exposes no window sources (the X11 capture below covers it).
        if (platform !== 'linux') {
          for (let attempt = 0; attempt < 3; attempt++) {
            signal.throwIfAborted();
            const sources = await desktopCapturer.getSources({
              types: ['window'],
              thumbnailSize: { width: 1280, height: 960 },
              fetchWindowIcons: false,
            });
            signal.throwIfAborted();
            source = sources.find((s) => s.id.split(':')[1] === window.id);
            if (source && !source.thumbnail.isEmpty()) break;
            if (attempt < 2) await delay(150 * (attempt + 1), undefined, { signal });
          }
        }
        let image = source?.thumbnail;
        let dialogBounds: WindowInfo['bounds'] | undefined;
        // Chromium omits owned Win32 dialogs from window sources. Capture only that
        // exact dialog HWND; never substitute a desktop screenshot or another app.
        if (
          (!image || image.isEmpty()) &&
          process.platform === 'win32' &&
          window.className === '#32770' &&
          window.ownerId &&
          window.ownerId !== '0'
        ) {
          const captured = await this.helper({ action: 'capture-dialog', window }, signal);
          image = nativeImage.createFromBuffer(Buffer.from(captured.data, 'base64'));
          dialogBounds = captured.bounds;
        }
        // The X11 addon reads window pixels directly, on the same connection as input.
        if ((!image || image.isEmpty()) && platform === 'linux') {
          try {
            const captured = (await x11Run({
              action: 'capture',
              windowId: window.id,
              pid: window.pid,
            })) as X11Capture;
            image = nativeImage.createFromBuffer(
              rgbaToPng(captured.width, captured.height, captured.data),
            );
          } catch {
            // Fall through to the unified error below.
          }
        }
        if (!image || image.isEmpty())
          throw new Error(
            process.platform === 'darwin'
              ? '未获取目标窗口图像。请检查屏幕录制权限，并保持窗口可见后重试。'
              : '未获取目标窗口图像。请保持窗口可见、退出最小化后重试；受保护窗口可能不允许截图。',
          );
        const { width, height } = image.getSize();
        const frameId = randomUUID();
        // Chromium's Windows window capturer excludes the title bar and invisible resize borders.
        // Align the image with the client bottom; image aspect also accounts for a native menu bar.
        const client = window.clientBounds;
        const captureBounds =
          dialogBounds ??
          (client && client.width > 0
            ? {
                x: client.x,
                y: client.y + client.height - (client.width * height) / width,
                width: client.width,
                height: (client.width * height) / width,
              }
            : window.bounds);
        for (const [id, frame] of this.frames)
          if (frame.expires < Date.now()) this.frames.delete(id);
        if (this.frames.size >= 20) this.frames.delete(this.frames.keys().next().value!);
        this.frames.set(frameId, {
          window,
          width,
          height,
          bounds: captureBounds,
          expires: Date.now() + 120000,
        });
        return {
          text: JSON.stringify({
            frameId,
            windowId: window.id,
            ...(window.id !== windowId
              ? {
                  requestedWindowId: windowId,
                  note: '原窗口被其确认弹窗阻挡；当前截图及 frameId 对应此弹窗。根据实际内容决定操作，不自动确认。',
                }
              : {}),
            window: window.title,
            width,
            height,
            captureBounds,
            coordinateSystem: '截图图片坐标，非屏幕坐标',
            expiresInSeconds: 120,
          }),
          images: [{ mimeType: 'image/jpeg', data: image.toJPEG(75).toString('base64') }],
        };
      }
      if (!computerTools.some((t) => t.name === name)) throw new Error('未知电脑工具');
      const { frameId } = z.object({ frameId: z.string() }).parse(args);
      const frame = this.frames.get(frameId);
      if (!frame || frame.expires < Date.now())
        throw new Error(
          '截图已用于上次操作或已过期，请重新截图观察窗口；每张截图只能执行一次动作。',
        );
      if (!this.status().accessibility) throw new Error('请先为同舟授予 macOS 辅助功能权限');
      const current: WindowInfo[] = await this.helper({ action: 'windows' }, signal);
      const window = current.find((w) => w.id === frame.window.id && w.pid === frame.window.pid);
      if (window?.enabled === false)
        throw new Error('目标窗口被弹窗阻挡，请重新截图观察确认框，不要复用原窗口坐标');
      if (
        !window ||
        JSON.stringify(window.bounds) !== JSON.stringify(frame.window.bounds) ||
        JSON.stringify(window.clientBounds) !== JSON.stringify(frame.window.clientBounds)
      )
        throw new Error('窗口已关闭或移动，请重新截图');
      const action = actionSchema.parse({ ...args, action: name.replace('computer_', '') });
      const payload: any = { ...action, window };
      if ('x' in action) Object.assign(payload, mapPoint(action.x, action.y, frame));
      if ('toX' in action) {
        const p = mapPoint(action.toX, action.toY, frame);
        payload.toX = p.x;
        payload.toY = p.y;
      }
      // Each screenshot authorizes one action only. Never reuse stale coordinates after changes.
      this.frames.delete(frameId);
      signal.throwIfAborted();
      await this.helper(payload, signal);
      return { text: '操作已发送。请重新截图确认实际结果；不能仅凭输入已发送判断任务成功。' };
    } finally {
      if (signal.aborted && !['computer_windows', 'computer_screenshot'].includes(name))
        await this.helper({ action: 'release' }, AbortSignal.timeout(10000)).catch(() => {});
      this.lock.busy = false;
    }
  }
}
