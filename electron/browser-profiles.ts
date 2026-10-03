import { BrowserWindow, session } from 'electron';
import type { Store } from './store';
import type { Connector } from '../src/shared/types';
import { serviceUrl } from './connectors';

/** Profiles belong to Tongzhou. Never read another browser's cookie database. */
export class BrowserProfiles {
  private windows = new Map<string, BrowserWindow>();
  constructor(private store: Store) {}
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
    const url = serviceUrl(c.baseUrl);
    const previous = this.windows.get(id);
    if (previous && !previous.isDestroyed()) {
      previous.focus();
      return { connectorId: id, reused: true, opened: true };
    }
    const s = session.fromPartition(this.partition(id));
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
        serviceUrl(target);
      } catch {
        e.preventDefault();
      }
    });
    w.webContents.setWindowOpenHandler(({ url: target }) => {
      try {
        serviceUrl(target);
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
  async clear(id: string) {
    this.windows.get(id)?.destroy();
    const s = session.fromPartition(this.partition(id));
    await s.clearStorageData();
    await s.clearCache();
    await s.cookies.flushStore();
  }
  dispose() {
    for (const w of this.windows.values()) w.destroy();
    this.windows.clear();
  }
}
