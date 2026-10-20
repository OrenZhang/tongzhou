import {
  desktopCapturer,
  systemPreferences,
  nativeImage,
  clipboard,
  BrowserWindow,
} from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputerControl, type ComputerDriver, type WindowInfo } from './computer';
import { computerHelper } from './computer-helper';
import { x11Available, x11Run, rgbaToPng, type X11Capture } from './linux-computer';
const driver: ComputerDriver = {
  status: () => ({
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
    emergencyShortcut: false,
  }),
  requestPermission() {
    if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true);
  },
  helper: (payload, signal) => computerHelper(payload, signal, (text) => clipboard.writeText(text)),
  async capture(window, signal) {
    let source: Awaited<ReturnType<typeof desktopCapturer.getSources>>[number] | undefined;
    // A newly shown window may be enumerated before its first capture frame exists.
    // Retry only the requested window; never substitute another window or a full screen.
    // Linux skips desktopCapturer entirely: on Wayland sessions it hangs waiting for
    // the capture portal and exposes no window sources (the X11 capture below covers it).
    if (process.platform !== 'linux') {
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
      const captured = await computerHelper({ action: 'capture-dialog', window }, signal);
      image = nativeImage.createFromBuffer(Buffer.from(captured.data, 'base64'));
      dialogBounds = captured.bounds;
    }
    // The X11 addon reads window pixels directly, on the same connection as input.
    if ((!image || image.isEmpty()) && process.platform === 'linux') {
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
    return {
      width,
      height,
      bounds: captureBounds,
      mimeType: 'image/jpeg',
      data: image.toJPEG(75).toString('base64'),
    };
  },
};
export class DesktopComputer extends ComputerControl {
  constructor() {
    super(driver);
  }
}

export async function electronComputerDiagnostic(computer: ComputerControl) {
  const { computerDiagnostic } = await import('./computer-diagnostic');
  return computerDiagnostic(computer, async (title, signal) => {
    const window = new BrowserWindow({
      width: 600,
      height: 300,
      title,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const close = () => {
      if (!window.isDestroyed()) window.destroy();
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<html><meta charset="utf-8"><title>${title}</title><h2>CoSail电脑控制自检</h2><p>只在此窗口验证截图与中文输入，数据不会发送到外部。</p><input id="sample" autofocus style="font-size:24px" /></html>`,
          ),
      );
      window.show();
      window.focus();
      await window.webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      return {
        pid: process.pid,
        read: () => window.webContents.executeJavaScript('document.querySelector("#sample").value'),
        close() {
          signal.removeEventListener('abort', close);
          close();
        },
      };
    } catch (error) {
      signal.removeEventListener('abort', close);
      close();
      throw error;
    }
  });
}
