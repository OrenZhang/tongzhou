import path from 'node:path';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { snapshotPage, actOnPage } from './browser-page';
import { BrowserWindow, session } from 'electron';
import type { Store } from '../storage/store';
import type { Connector } from '../../../src/shared/types';
import { browserUrl } from '../accounts/connectors';

/** Profiles belong to Tongzhou. Never read another browser's cookie database. */
export class BrowserProfiles {
  private windows = new Map<string, BrowserWindow>();
  private downloadsReady = new Set<string>();
  private downloadHandlers = new Map<string, (...args: any[]) => void>();
  private disposed = false;
  constructor(
    private store: Store,
    private dataDir = path.join(os.tmpdir(), 'tongzhou-browser'),
  ) {}
  downloads(id: string) {
    this.store.get('connector', id);
    return this.store
      .list<any>('browserDownload')
      .filter((d) => d.connectorId === id)
      .slice(-50);
  }
  private prepareDownloads(id: string, s: Electron.Session) {
    if (this.downloadsReady.has(id)) return;
    this.downloadsReady.add(id);
    const handler = (_event: Electron.Event, item: Electron.DownloadItem) => {
      const directory = path.join(this.dataDir, 'browser-downloads', id);
      mkdirSync(directory, { recursive: true });
      const name =
        path
          .basename(item.getFilename())
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .slice(0, 140) || 'download';
      const record = {
        id: randomUUID(),
        connectorId: id,
        name,
        path: path.join(directory, randomUUID() + '-' + name),
        status: 'progressing',
        bytes: 0,
        total: item.getTotalBytes(),
        createdAt: Date.now(),
      };
      item.setSavePath(record.path);
      this.store.put('browserDownload', record);
      item.on('done', (_e, state) => {
        if (this.disposed) return;
        record.status = state;
        record.bytes = item.getReceivedBytes();
        this.store.put('browserDownload', record);
      });
    };
    s.on('will-download', handler);
    this.downloadHandlers.set(id, handler);
  }
  private partition(id: string) {
    return 'persist:tongzhou-connector-' + id;
  }
  async status(id: string) {
    const c = this.store.get<Connector>('connector', id);
    const w = this.windows.get(id);
    const cookies = await session.fromPartition(this.partition(id)).cookies.get({});
    return {
      connectorId: id,
      name: c.name,
      enabled: c.enabled,
      open: !!w && !w.isDestroyed(),
      hasStoredCookies: cookies.length > 0,
      note: '登录态由独立浏览器管理。Cookie 存在不等于已登录，请在网页确认；不会返回 Cookie 或密码。',
    };
  }
  close(id: string) {
    this.windows.get(id)?.destroy();
  }
  async open(id: string) {
    const c = this.store.get<Connector>('connector', id);
    if (!c.enabled) throw new Error('连接器已停用');
    const url = browserUrl(c.baseUrl);
    const previous = this.windows.get(id);
    if (previous && !previous.isDestroyed()) {
      previous.focus();
      return { connectorId: id, reused: true, opened: true };
    }
    const s = session.fromPartition(this.partition(id));
    this.prepareDownloads(id, s);
    s.setPermissionRequestHandler((_w, _p, callback) => callback(false));
    const w = new BrowserWindow({
      width: 1050,
      height: 800,
      title: c.name + ' · 独立浏览器',
      autoHideMenuBar: true,
      webPreferences: {
        session: s,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.windows.set(id, w);
    w.webContents.on('will-navigate', (e, target) => {
      try {
        browserUrl(target);
      } catch {
        e.preventDefault();
      }
    });
    w.webContents.setWindowOpenHandler(({ url: target }) => {
      try {
        browserUrl(target);
        void w.loadURL(target);
      } catch {
        /* reject executable schemes */
      }
      return { action: 'deny' };
    });
    w.on('closed', () => {
      this.windows.delete(id);
      void s.cookies.flushStore();
    });
    try {
      await w.loadURL(url.href);
      return { connectorId: id, reused: false, opened: true };
    } catch {
      // A failed hidden/blank window must not masquerade as a successful reused profile.
      if (!w.isDestroyed()) w.destroy();
      throw new Error('无法打开此服务的浏览器，请检查连接地址与网络后重试');
    }
  }
  private windowFor(id: string) {
    const c = this.store.get<Connector>('connector', id),
      w = this.windows.get(id);
    if (!c.enabled || !w || w.isDestroyed()) throw new Error('请先打开已启用服务的独立浏览器');
    return w;
  }
  async snapshot(id: string) {
    const w = this.windowFor(id);
    return w.webContents.executeJavaScriptInIsolatedWorld(1004, [
      { code: '(' + snapshotPage.toString() + ')(' + JSON.stringify(randomUUID()) + ')' },
    ]);
  }
  async action(id: string, input: Parameters<typeof actOnPage>[0]) {
    const w = this.windowFor(id);
    const result = await w.webContents.executeJavaScriptInIsolatedWorld(
      1004,
      [
        {
          code:
            '(()=>{try{return (' +
            actOnPage.toString() +
            ')(' +
            JSON.stringify(input) +
            ')}catch(e){return {error:String(e.message||e)}}})()',
        },
      ],
      true,
    );
    if (result?.error) throw new Error(result.error);
    return result;
  }
  async navigate(id: string, url: string) {
    const w = this.windowFor(id);
    await w.loadURL(browserUrl(url).href);
    return this.snapshot(id);
  }
  async press(id: string, key: string) {
    const w = this.windowFor(id);
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    return { sent: true, note: '请重新读取页面验证' };
  }
  async clear(id: string) {
    this.windows.get(id)?.destroy();
    const s = session.fromPartition(this.partition(id));
    await s.clearStorageData();
    await s.clearCache();
    await s.cookies.flushStore();
  }
  dispose() {
    this.disposed = true;
    for (const [id, handler] of this.downloadHandlers)
      session.fromPartition(this.partition(id)).removeListener('will-download', handler);
    this.downloadHandlers.clear();
    for (const w of this.windows.values()) w.destroy();
    this.windows.clear();
  }
}
