import { BrowserWindow, ipcMain, screen, type Rectangle, type IpcMainEvent } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type { ComputerPermission, ComputerPermissions } from './computer-permissions';

import { permissionPanelBounds, permissionPanelHTML } from './permission-panel-view';

const run = promisify(execFile);

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
      title: 'CoSail授权助手',
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
    const url =
      'data:text/html;charset=utf-8,' + encodeURIComponent(permissionPanelHTML(guide, permission));
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
