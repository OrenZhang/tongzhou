import { BrowserWindow, session, shell, type Session } from 'electron';
import { accountProxyConfig } from './provider-network';
import { networkKey } from '../src/shared/provider-network';
import { loginUrl } from './codex-auth';
import type { Store } from './store';
import type { Provider } from '../src/shared/types';

function safeNavigation(raw: string) {
  try {
    const url = new URL(raw);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
/** In-memory browser sessions are per account and never share the app's default session. */
export class AccountBrowser {
  private windows = new Map<string, BrowserWindow>();
  private generations = new Map<string, number>();
  private configured = new WeakSet<Session>();
  constructor(private store: Store) {}
  private provider(id: string) {
    const p = this.store.get<Provider>('provider', id);
    if (p.protocol !== 'codex') throw new Error('网络设置仅适用于 ChatGPT 连接');
    return p;
  }
  async networkSession(id: string): Promise<Session> {
    const provider = this.provider(id);
    // Include the network identity so an old async authorization can never reconfigure
    // a newly selected network. No persistent cookies or password API is exposed.
    const s = session.fromPartition(
      'tongzhou-chatgpt-' + id + '-' + Buffer.from(networkKey(provider.network)).toString('hex'),
    );
    await s.setProxy(accountProxyConfig(provider.network));
    s.setPermissionRequestHandler((_w, _permission, done) => done(false));
    s.setPermissionCheckHandler(() => false);
    if (!this.configured.has(s)) {
      s.on('will-download', (event) => event.preventDefault());
      this.configured.add(s);
    }
    return s;
  }
  async open(url: string, id: string) {
    loginUrl(url);
    const provider = this.provider(id);
    if (!provider.network || provider.network.mode === 'inherit') return shell.openExternal(url);
    this.close(id);
    const generation = this.generations.get(id);
    const s = await this.networkSession(id);
    if (generation !== this.generations.get(id))
      throw new Error('账号网络配置已改变，请重新打开授权页面');
    const w = new BrowserWindow({
      title: `${provider.name} · 独立授权窗口`,
      width: 900,
      height: 760,
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
      if (!safeNavigation(target)) e.preventDefault();
    });
    w.webContents.on('will-redirect', (e, target) => {
      if (!safeNavigation(target)) e.preventDefault();
    });
    w.webContents.setWindowOpenHandler(({ url: target }) => {
      if (safeNavigation(target)) void w.loadURL(target).catch(() => {});
      return { action: 'deny' };
    });
    w.on('closed', () => {
      if (this.windows.get(id) === w) this.windows.delete(id);
    });
    try {
      await w.loadURL(url);
    } catch {
      if (this.windows.get(id) === w) this.close(id);
      throw new Error('独立授权页面未能打开，请检查此账号代理；也可改用设备码登录。');
    }
  }
  async test(id: string) {
    const s = await this.networkSession(id);
    const started = Date.now();
    try {
      const response = await s.fetch('https://auth.openai.com/.well-known/openid-configuration', {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`授权服务返回 HTTP ${response.status}`);
      return `账号网络可达（${Date.now() - started} ms）。未执行登录或模型推理。`;
    } catch (e: any) {
      throw new Error('账号网络测试失败：' + (e.message || String(e)));
    }
  }
  close(id: string) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1);
    this.windows.get(id)?.destroy();
    this.windows.delete(id);
  }
  dispose() {
    for (const id of [...this.windows.keys()]) this.close(id);
  }
}
