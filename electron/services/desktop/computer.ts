import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ComputerAdapter } from '../../core/tools/extensions';
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
export type WindowInfo = {
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
export interface ComputerDriver {
  status(): ComputerStatus;
  refresh?(): Promise<void>;
  requestPermission(): void | Promise<void>;
  helper(payload: any, signal: AbortSignal): Promise<any>;
  capture(
    window: WindowInfo,
    signal: AbortSignal,
  ): Promise<{
    width: number;
    height: number;
    bounds?: WindowInfo['bounds'];
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    data: string;
  }>;
}
export class ComputerControl implements ComputerAdapter {
  private frames = new Map<string, Frame>();
  constructor(
    private driver: ComputerDriver,
    private lock = { busy: false, emergencyShortcut: false },
  ) {}
  get emergencyShortcut() {
    return this.lock.emergencyShortcut;
  }
  set emergencyShortcut(value: boolean) {
    this.lock.emergencyShortcut = value;
  }
  fork() {
    return new ComputerControl(this.driver, this.lock);
  }
  status(): ComputerStatus {
    return { ...this.driver.status(), emergencyShortcut: this.emergencyShortcut };
  }
  async refresh() {
    await this.driver.refresh?.();
  }
  async requestPermission() {
    await this.driver.requestPermission();
    await this.refresh();
  }
  specs(readOnly: boolean) {
    return computerTools.filter((_, i) => !readOnly || i < 2);
  }
  private helper(payload: unknown, signal: AbortSignal) {
    return this.driver.helper(payload, signal);
  }
  async execute(name: string, args: any, signal: AbortSignal): Promise<ToolOutput> {
    await this.refresh();
    if (!this.status().supported)
      throw new Error('电脑控制需要 Windows、macOS，或带 X11/XWayland 显示的 Linux');
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
          throw new Error('请在 macOS 系统设置授予CoSail屏幕录制权限后重启');
        const windows: WindowInfo[] = await this.helper({ action: 'windows' }, signal);
        const window = observedWindow(windows, windowId);
        const captured = await this.driver.capture(window, signal);
        const { width, height } = captured;
        if (!(width > 0 && height > 0) || !captured.data) throw new Error('未获取目标窗口图像');
        const frameId = randomUUID();
        const captureBounds = captured.bounds ?? window.bounds;
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
          images: [{ mimeType: captured.mimeType, data: captured.data }],
        };
      }
      if (!computerTools.some((t) => t.name === name)) throw new Error('未知电脑工具');
      const { frameId } = z.object({ frameId: z.string() }).parse(args);
      const frame = this.frames.get(frameId);
      if (!frame || frame.expires < Date.now())
        throw new Error(
          '截图已用于上次操作或已过期，请重新截图观察窗口；每张截图只能执行一次动作。',
        );
      if (!this.status().accessibility) throw new Error('请先为CoSail授予 macOS 辅助功能权限');
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
