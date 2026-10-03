import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { PluginConfig } from '../src/shared/types';
import type { Store } from './store';
import { serviceFetch } from './service-network';
export const mcpRedirect = 'http://127.0.0.1:17438/mcp/callback';
interface Saved {
  url: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  revision: string;
}
export function pluginAuthIdentity(p: PluginConfig) {
  return JSON.stringify([
    p.transport,
    p.url,
    p.authMode ?? 'headers',
    p.oauthClientId ?? '',
    p.oauthIssuer ?? '',
  ]);
}
export function secureOAuthUrl(value: string | URL) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    !(
      u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    )
  )
    throw new Error('授权服务必须使用 HTTPS 或本机 HTTP');
  return u;
}
const secureUrl = secureOAuthUrl;
export const oauthFetch: typeof fetch = async (input, init) => {
  secureUrl(input instanceof Request ? input.url : String(input));
  return serviceFetch(input, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20000)]),
  });
};
export class PluginOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = mcpRedirect;
  private identity: string;
  private epoch: string;
  constructor(
    private store: Store,
    private config: PluginConfig,
    private redirect?: (url: URL) => Promise<void>,
    private nonce?: string,
    private signal?: AbortSignal,
  ) {
    this.identity = pluginAuthIdentity(config);
    this.epoch = this.generation();
  }
  private generation() {
    return (
      this.store
        .list<{ id: string; value: string }>('mcpAuthEpoch')
        .find((p) => p.id === this.config.id)?.value ?? ''
    );
  }
  private check() {
    this.signal?.throwIfAborted();
    const now = this.store.list<PluginConfig>('plugin').find((p) => p.id === this.config.id);
    if (!now || pluginAuthIdentity(now) !== this.identity || this.generation() !== this.epoch)
      throw new Error('插件地址或认证配置已变化，请重新授权');
  }
  private read(): Saved {
    this.check();
    const text = this.store.secret('plugin_oauth_' + this.config.id);
    const value: Saved = text ? JSON.parse(text) : { url: this.config.url, revision: '' };
    if (value.url !== this.config.url) throw new Error('授权与插件地址不匹配');
    return value;
  }
  private write(value: Saved) {
    this.check();
    this.store.saveSecret('plugin_oauth_' + this.config.id, JSON.stringify(value));
  }
  get clientMetadata() {
    const methods =
      this.read().discovery?.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
    const method =
      methods?.includes('none') || !methods?.length
        ? 'none'
        : methods.includes('client_secret_post')
          ? 'client_secret_post'
          : 'client_secret_basic';
    return {
      client_name: '同舟 Tongzhou',
      redirect_uris: [mcpRedirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    };
  }
  state() {
    if (!this.nonce) throw new Error('请在插件与工具中点击浏览器授权');
    return this.nonce;
  }
  clientInformation() {
    const v = this.read();
    return (
      v.client ??
      (this.config.oauthClientId
        ? {
            client_id: this.config.oauthClientId,
            issuer: this.config.oauthIssuer,
            client_secret: this.store.secret('plugin_oauth_client_' + this.config.id) || undefined,
            ...(this.config.url === 'https://api.githubcopilot.com/mcp/'
              ? { token_endpoint_auth_method: 'client_secret_post' as const }
              : {}),
          }
        : undefined)
    );
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.write({ ...this.read(), client });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    const v = this.read();
    this.write({
      ...v,
      tokens: {
        ...tokens,
        refresh_token:
          tokens.refresh_token ??
          (tokens.issuer === v.tokens?.issuer ? v.tokens?.refresh_token : undefined),
      },
    });
  }
  async redirectToAuthorization(url: URL) {
    this.check();
    secureUrl(url);
    if (!this.redirect) throw new Error('插件需要重新授权，请在插件与工具中操作');
    await this.redirect(url);
  }
  saveCodeVerifier(verifier: string) {
    this.write({ ...this.read(), verifier });
  }
  codeVerifier() {
    const v = this.read().verifier;
    if (!v) throw new Error('授权已过期，请重新登录');
    return v;
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    secureUrl(discovery.authorizationServerUrl);
    this.write({ ...this.read(), discovery });
  }
  discoveryState() {
    return this.read().discovery;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const v = this.read();
    if (scope === 'all') {
      this.write({ url: this.config.url, revision: randomUUID() });
      return;
    }
    delete v[scope];
    this.write(v);
  }
  sensitiveValues() {
    const v = this.read();
    return [
      v.tokens?.access_token,
      v.tokens?.refresh_token,
      v.client?.client_secret,
      this.store.secret('plugin_oauth_client_' + this.config.id),
      v.verifier,
    ].filter((s): s is string => !!s);
  }
}
export function pluginOAuth(store: Store, p: PluginConfig) {
  return p.authMode === 'oauth' ? new PluginOAuthProvider(store, p) : undefined;
}
export class McpAuth {
  private pending?: { id: string; cancel(): void };
  constructor(
    private store: Store,
    private changed: () => void,
    private open: (url: string) => Promise<unknown>,
    private request: typeof auth = auth,
  ) {
    for (const p of store.list<PluginConfig>('plugin'))
      if (p.oauthStatus === 'waiting' || p.oauthStatus === 'starting')
        this.status(p.id, 'error', '上次授权已中断，请重新授权。');
  }
  status(id: string, status: PluginConfig['oauthStatus'], error?: string) {
    const p = this.store.list<PluginConfig>('plugin').find((p) => p.id === id);
    if (!p) return;
    this.store.put('plugin', { ...p, oauthStatus: status, oauthError: error });
    this.store.put('authEvent', {
      id: randomUUID(),
      providerId: id,
      phase: 'mcp-' + status,
      time: Date.now(),
    });
    this.changed();
  }
  cancel(id: string) {
    if (this.pending?.id === id) {
      this.pending.cancel();
      this.status(id, 'cancelled');
    }
  }
  logout(id: string) {
    this.cancel(id);
    this.store.put('mcpAuthEpoch', { id, value: randomUUID() });
    this.store.saveSecret('plugin_oauth_' + id, undefined, true);
    this.status(id, 'none');
  }
  async login(id: string) {
    if (this.pending) throw new Error('请先完成或关闭当前插件授权');
    const config = this.store.get<PluginConfig>('plugin', id);
    if (config.transport !== 'http' || config.authMode !== 'oauth')
      throw new Error('请先将此插件设置为 OAuth 认证');
    if (
      new URL(config.url).hostname === 'api.githubcopilot.com' &&
      (!config.oauthClientId || !this.store.hasSecret('plugin_oauth_client_' + id))
    ) {
      const message =
        'GitHub 浏览器授权需要你自己的 OAuth App Client ID 和 Client Secret；GitHub 不支持自动注册应用。也可选择访问令牌或复用连接中心已授权的 GitHub 账号。';
      this.status(id, 'error', message);
      throw new Error(message);
    }
    const controller = new AbortController(),
      nonce = randomBytes(32).toString('base64url');
    let consumed = false,
      finished = false;
    let authorizationUrl: string | undefined,
      browserOpened = false;
    let failure = '';
    const explain = (e: unknown) => {
      if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE')
        return '本机授权回调端口 17438 已被占用，请关闭其他插件授权窗口后重试。';
      if (failure) return failure;
      if (/does not support dynamic client registration/i.test(String(e)))
        return '此服务不支持自动注册 OAuth 应用，请配置自己的 Client ID、Client Secret 和授权服务地址，或使用访问令牌。';
      return '授权未完成。请检查应用的 Client ID、Client Secret、回调地址及授权范围后重试。';
    };
    const provider = new PluginOAuthProvider(
      this.store,
      config,
      async (url) => {
        authorizationUrl = url.href;
        this.status(id, 'waiting');
        try {
          await this.open(url.href);
          browserOpened = true;
        } catch {
          browserOpened = false;
        }
      },
      nonce,
      controller.signal,
    );
    const requestFetch: typeof fetch = async (url, init) => {
      const target = secureUrl(url instanceof Request ? url.url : String(url));
      let response: Response;
      try {
        response = await oauthFetch(url, {
          ...init,
          signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
        });
      } catch (e) {
        failure = `无法连接 ${target.hostname} 的授权服务。请求已使用系统代理，请检查该站点的代理、DNS 和网络连接。`;
        throw e;
      }
      if (!response.ok && response.status !== 404) {
        const registration = /register/.test(target.pathname);
        failure =
          registration && target.hostname === 'api.figma.com' && response.status === 403
            ? 'Figma 拒绝客户端注册（HTTP 403）。远程 MCP 需要 Figma 认可的客户端；可填写已获准的 OAuth 应用信息，或改用 Figma 桌面 MCP。'
            : `${target.hostname} ${registration ? '拒绝应用注册' : /token/.test(target.pathname) ? '未能交换授权令牌' : '授权请求失败'}（HTTP ${response.status}）。请检查应用配置和账号权限。`;
      }
      return response;
    };
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', mcpRedirect);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (
        req.method !== 'GET' ||
        req.headers.host !== '127.0.0.1:17438' ||
        u.pathname !== '/mcp/callback' ||
        u.searchParams.get('state') !== nonce ||
        consumed ||
        controller.signal.aborted
      ) {
        res.writeHead(400);
        res.end('无效的授权回调');
        return;
      }
      consumed = true;
      try {
        const code = u.searchParams.get('code');
        if (!code || code.length > 8000 || u.searchParams.has('error'))
          throw new Error('cancelled');
        const issuer = u.searchParams.get('iss');
        if (issuer && issuer !== provider.discoveryState()?.authorizationServerUrl)
          throw new Error('Invalid issuer');
        failure = '';
        if (
          (await this.request(provider, {
            serverUrl: config.url,
            authorizationCode: code,
            scope:
              new URL(config.url).hostname === 'api.githubcopilot.com'
                ? 'repo read:user'
                : undefined,
            fetchFn: requestFetch,
          })) !== 'AUTHORIZED'
        )
          throw new Error('not authorized');
        provider.invalidateCredentials('verifier');
        this.status(id, 'authorized');
        res.end('同舟：插件授权已保存，可以关闭此页面。');
      } catch (e) {
        const message = u.searchParams.has('error')
          ? '你已取消或拒绝授权，可以重新发起。'
          : explain(e);
        if (!controller.signal.aborted) this.status(id, 'error', message);
        res.writeHead(400);
        res.end(message);
      } finally {
        res.once('finish', close);
        if (res.writableFinished) close();
      }
    });
    const timer = setTimeout(
      () => {
        this.status(id, 'error', '浏览器授权已超时，请重新授权。');
        close();
      },
      5 * 60 * 1000,
    );
    timer.unref();
    const close = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      controller.abort();
      server.closeAllConnections();
      server.close();
      if (this.pending?.id === id) this.pending = undefined;
    };
    this.pending = { id, cancel: close };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(17438, '127.0.0.1', resolve);
      });
      this.status(id, 'starting');
      const result = await this.request(provider, {
        serverUrl: config.url,
        fetchFn: requestFetch,
        scope:
          new URL(config.url).hostname === 'api.githubcopilot.com' ? 'repo read:user' : undefined,
      });
      controller.signal.throwIfAborted();
      if (result === 'AUTHORIZED') {
        this.status(id, 'authorized');
        close();
      }
      return { url: authorizationUrl, browserOpened };
    } catch (e) {
      const message = controller.signal.aborted ? '授权已取消。' : explain(e);
      if (!controller.signal.aborted) this.status(id, 'error', message);
      close();
      throw new Error(message);
    }
  }
  dispose() {
    this.pending?.cancel();
  }
}
