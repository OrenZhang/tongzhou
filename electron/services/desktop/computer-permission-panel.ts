import { BrowserWindow, ipcMain, screen, type Rectangle, type IpcMainEvent } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type { ComputerPermissionGuide } from '../../../src/shared/types';
import type { ComputerPermission, ComputerPermissions } from './computer-permissions';

const run = promisify(execFile);
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function permissionPanelBounds(settings: Rectangle | null, area: Rectangle): Rectangle {
  const width = Math.min(360, area.width),
    height = 180,
    gap = 12;
  let x = settings ? settings.x + (settings.width - width) / 2 : area.x + (area.width - width) / 2;
  let y = settings ? settings.y + settings.height + gap : area.y + area.height - height - gap;
  if (settings && y + height > area.y + area.height) {
    y = settings.y + settings.height - height;
    if (settings.x + settings.width + gap + width <= area.x + area.width)
      x = settings.x + settings.width + gap;
    else if (settings.x - gap - width >= area.x) x = settings.x - gap - width;
    else y = area.y + area.height - height - gap;
  }
  return {
    x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
    width,
    height,
  };
}

function panelHTML(guide: ComputerPermissionGuide, permission: ComputerPermission) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"><title>同舟授权助手</title><style>
  :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:12px 16px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:light-dark(#292b30,#eee);background:light-dark(#fafafa,#242528);user-select:none;border:1px solid light-dark(#e3e4e7,#424449);border-radius:12px;height:100vh}header{display:flex;align-items:center;justify-content:space-between;-webkit-app-region:drag;font-size:12px;color:light-dark(#62656c,#b6b8be)}button{-webkit-app-region:no-drag;cursor:pointer;font:inherit;color:inherit;border:0;background:transparent}#close{font-size:19px;line-height:18px;padding:0 2px}#application{margin:10px 0 8px;width:100%;display:flex;align-items:center;gap:12px;border:1px dashed light-dark(#c9ccd3,#60636b);border-radius:9px;padding:10px 12px;text-align:left;cursor:grab}#application:active{cursor:grabbing}#application img{width:40px;height:40px;border-radius:9px}#application strong{font-size:15px;font-weight:600;display:block}#application small{display:block;margin-top:4px;color:light-dark(#666a73,#b6b8be);font-size:12px}.grip{margin-left:auto;font-size:22px;color:light-dark(#757982,#a0a4ad)}p{font-size:11px;line-height:16px;margin:0;color:light-dark(#62656c,#b6b8be)}#reveal{padding:4px 0;font-size:11px;text-decoration:underline;text-underline-offset:2px}#feedback{color:light-dark(#b73737,#f19494);font-size:11px}button:focus-visible{outline:2px solid #627bad;outline-offset:2px}
  </style></head><body><header><span>${permission === 'accessibility' ? '辅助功能' : '屏幕录制'}授权</span><button id="close" aria-label="关闭授权助手">×</button></header><button id="application" draggable="true" aria-label="拖动 ${escape(guide.name)} 到系统设置"><img src="${escape(guide.icon)}" alt="" draggable="false"><span><strong>${escape(guide.name)}</strong><small>拖动此图标添加应用</small></span><span class="grip" aria-hidden="true">⠿</span></button><p>拖入系统设置的应用列表，再打开开关。</p><button id="reveal">在 Finder 中显示</button><span id="feedback" role="alert"></span></body></html>`;
}

/** A nonactivating panel lets System Settings stay in front during native app dragging. */
export class ComputerPermissionPanel {
  private window?: BrowserWindow;
  constructor(private permissions: ComputerPermissions) {}

  async open(permission: ComputerPermission) {
    const guide = await this.permissions.guide();
    if (!guide) throw new Error('此授权引导仅适用于 macOS。');
    await this.permissions.openSettings(permission);
    let settings: Rectangle | null = null;
    const helper = path
      .join(__dirname, '../build/computer/macos-settings-bounds.js')
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    for (let attempt = 0; attempt < 3 && !settings; attempt++) {
      if (attempt) await delay(150);
      try {
        const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', helper], {
          timeout: 3000,
          maxBuffer: 8192,
        });
        const value = JSON.parse(stdout.trim());
        if (
          value &&
          ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) &&
          value.width > 0 &&
          value.height > 0
        )
          settings = value;
      } catch {
        /* The panel remains available even when system window bounds are unavailable. */
      }
    }
    const area = settings
      ? screen.getDisplayMatching(settings).workArea
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    this.close();
    const panel = new BrowserWindow({
      ...permissionPanelBounds(settings, area),
      title: '同舟授权助手',
      type: 'panel',
      frame: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'permission-panel-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.window = panel;
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(panelHTML(guide, permission));
    const channels = ['drag', 'reveal', 'close'] as const;
    const listeners = channels.map((action) => {
      const handler = (event: IpcMainEvent) => {
        if (
          this.window !== panel ||
          event.sender !== panel.webContents ||
          event.senderFrame !== panel.webContents.mainFrame ||
          event.senderFrame.url !== url
        )
          return;
        try {
          if (action === 'close') this.close();
          else if (action === 'drag') this.permissions.startDrag(panel.webContents);
          else
            void this.permissions.revealApplication().catch((error) => {
              if (!panel.isDestroyed())
                panel.webContents.send('tongzhou:permission-panel-error', String(error.message));
            });
        } catch (error) {
          if (!panel.isDestroyed())
            panel.webContents.send(
              'tongzhou:permission-panel-error',
              String((error as Error).message),
            );
        }
      };
      const channel = 'tongzhou:permission-panel-' + action;
      ipcMain.on(channel, handler);
      return { channel, handler };
    });
    panel.once('closed', () => {
      for (const { channel, handler } of listeners) ipcMain.removeListener(channel, handler);
      if (this.window === panel) this.window = undefined;
    });
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', (event) => event.preventDefault());
    panel.webContents.on('will-attach-webview', (event) => event.preventDefault());
    try {
      await panel.loadURL(url);
      panel.showInactive();
    } catch (error) {
      panel.destroy();
      throw error;
    }
  }

  close() {
    if (this.window && !this.window.isDestroyed()) this.window.close();
  }
}
