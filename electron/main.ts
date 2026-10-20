import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeTheme, Tray } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppEvent, ProviderInput } from '../src/shared/types';
import { DesktopComputer } from './services/desktop/electron-computer';
import { linuxPasswordStore } from './services/desktop/secret-store';
import { ComputerPermissions } from './services/desktop/computer-permissions';
import { ComputerPermissionPanel } from './services/desktop/computer-permission-panel';
import { guardPreviewNavigation } from './services/desktop/preview-navigation';
import './services/network/node-request-identity';
import { browserUserAgent } from './services/network/request-identity';
import { redact } from './services/storage/validation';
import { DesktopApplication } from './application/application';
import type { Updates } from './services/desktop/updates';

// Keep the original profile and encryption keys across the CoSail rename.
const profile = process.env.TONGZHOU_USER_DATA || path.join(app.getPath('appData'), 'Tongzhou');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setName('CoSail');
app.on('session-created', (s) => s.setUserAgent(browserUserAgent(s.getUserAgent())));
const linuxStore = linuxPasswordStore(process.platform, process.env, process.argv);
if (linuxStore) app.commandLine.appendSwitch('password-store', linuxStore);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let application: DesktopApplication | undefined;
const computer = new DesktopComputer();
const computerPermissions = new ComputerPermissions();
const computerPermissionPanel = new ComputerPermissionPanel(computerPermissions);
let quitting = false;
let nativeLanguage: 'zh-CN' | 'en' = 'zh-CN';
const nativeText = (zh: string, en: string) => (nativeLanguage === 'en' ? en : zh);
const pendingImports = new Map<string, ProviderInput>();
const page = path.join(__dirname, '../dist/index.html');
function trusted(url: string) {
  return process.env.TONGZHOU_DEV_URL
    ? url === process.env.TONGZHOU_DEV_URL + '/'
    : url === pathToFileURL(page).href;
}
function emit(event: AppEvent) {
  if (event.type === 'appearance' && event.value.language) {
    nativeLanguage = event.value.language;
    refreshNativeMenus();
  }
  if (window && !window.isDestroyed()) window.webContents.send('tongzhou:event', event);
}
async function setup() {
  application = new DesktopApplication({
    dataDir: app.getPath('userData'),
    bundleDir: __dirname,
    emit,
    getWindow: () => window,
    trusted,
    computer,
    computerPermissions,
    computerPermissionPanel,
    pendingImports,
  });
  await application.start();
}
function showWindow() {
  if (quitting || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function createTray() {
  if (process.platform !== 'win32') return;
  tray = new Tray(path.join(__dirname, '../build/icon.ico'));
  tray.setToolTip('CoSail');
  refreshNativeMenus();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}
function refreshNativeMenus() {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: nativeText('打开CoSail', 'Open CoSail'), click: showWindow },
      { type: 'separator' },
      { label: nativeText('退出CoSail', 'Quit CoSail'), click: () => app.quit() },
    ]),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      {
        label: nativeText('编辑', 'Edit'),
        submenu: [
          { role: 'undo', label: nativeText('撤销', 'Undo') },
          { role: 'redo', label: nativeText('重做', 'Redo') },
          { type: 'separator' },
          { role: 'cut', label: nativeText('剪切', 'Cut') },
          { role: 'copy', label: nativeText('复制', 'Copy') },
          { role: 'paste', label: nativeText('粘贴', 'Paste') },
          { role: 'selectAll', label: nativeText('全选', 'Select All') },
        ],
      },
    ]),
  );
}
async function createWindow() {
  const icon = path.join(
    __dirname,
    process.platform === 'darwin' ? '../build/icon-mac.png' : '../build/icon.png',
  );
  if (process.platform === 'darwin') app.dock?.setIcon(icon);
  refreshNativeMenus();
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    title: 'CoSail',
    icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191e' : '#fafbfc',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('focus', () => computerPermissionPanel.close());
  window.on('close', (event) => {
    if (quitting || !tray || tray.isDestroyed()) return;
    event.preventDefault();
    computerPermissionPanel.close();
    window?.hide();
  });
  // Windows shutdown/logoff must not be intercepted by close-to-tray.
  window.on('query-session-end', () => {
    quitting = true;
  });
  window.on('closed', () => {
    computerPermissionPanel.close();
    window = undefined;
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  // Generated UI can run locally, but cannot navigate to files, sites or app protocols.
  const previewUrl = process.env.TONGZHOU_DEV_URL
    ? new URL('/interactive-preview.html', process.env.TONGZHOU_DEV_URL).href
    : pathToFileURL(path.join(__dirname, '../dist/interactive-preview.html')).href;
  guardPreviewNavigation(window.webContents, previewUrl);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.selectionText) items.push({ label: nativeText('复制', 'Copy'), role: 'copy' });
    if (params.isEditable)
      items.push(
        { label: nativeText('剪切', 'Cut'), role: 'cut' },
        { label: nativeText('粘贴', 'Paste'), role: 'paste' },
      );
    if (!items.length) return;
    items.push(
      { type: 'separator' },
      { label: nativeText('全选', 'Select All'), role: 'selectAll' },
    );
    Menu.buildFromTemplate(items).popup({ window });
  });
  window.once('ready-to-show', () => window?.show());
  if (process.env.TONGZHOU_DEV_URL) await window.loadURL(process.env.TONGZHOU_DEV_URL);
  else await window.loadFile(page);
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', showWindow);
  app
    .whenReady()
    .then(async () => {
      await setup();
      const tasks = application!.tasks;
      const updates = application!.kernel.get<Updates>('tzUpdates');
      createTray();
      await createWindow();
      if (!process.env.TONGZHOU_DISABLE_UPDATES) updates.start();
      computer.emergencyShortcut = globalShortcut.register('CommandOrControl+Alt+Escape', () => {
        application!.kernel.context.tzTerminals.stopAll();
        for (const r of tasks.snapshot().runs)
          if (r.status === 'running') void tasks.cancel(r.sessionId);
      });
    })
    .catch((error) => {
      dialog.showErrorBox('CoSail启动失败', redact(String(error)));
      app.exit(1);
    });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    else showWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    if (!application) return;
    event.preventDefault();
    globalShortcut.unregisterAll();
    void application
      .stop()
      .catch((error) => console.error(redact(String(error))))
      .finally(() => app.quit());
  });
  app.on('will-quit', () => {
    tray?.destroy();
    tray = undefined;
  });
}
