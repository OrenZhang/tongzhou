import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Store } from '../storage/store';
import { idSchema } from '../storage/validation';
import type { Connector } from '../../../src/shared/types';
import { gitlabLogin } from './oauth-pkce';
import { serviceFetch } from '../network/service-network';

export const connectorSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['github', 'gitlab', 'browser']),
  enabled: z.boolean(),
  baseUrl: z.string().url().max(2000),
  clientId: z.string().max(200).optional(),
  secret: z.string().max(10000).optional(),
  clearSecret: z.boolean().optional(),
});
export function serviceUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('连接地址必须是无凭据的 HTTPS 地址');
  return url;
}
export function browserUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    !url.username &&
    !url.password
  )
    return url;
  return serviceUrl(value);
}
export class Connectors {
  private pending = new Map<string, AbortController>();
  constructor(
    private store: Store,
    private changed: () => void,
  ) {}
  list(): Connector[] {
    return this.store
      .list<Connector>('connector')
      .map((c) => ({ ...c, hasSecret: this.store.hasSecret('connector_' + c.id) }));
  }
  save(raw: unknown) {
    const { secret, clearSecret, ...config } = connectorSchema.parse(raw);
    const url = config.kind === 'browser' ? browserUrl(config.baseUrl) : serviceUrl(config.baseUrl);
    if (config.kind !== 'browser' && (url.pathname !== '/' || url.search || url.hash))
      throw new Error('服务地址只填写站点根地址');
    const old = this.list().find((c) => c.id === config.id);
    this.cancel(config.id);
    if (
      old &&
      (old.baseUrl !== config.baseUrl ||
        old.kind !== config.kind ||
        old.clientId !== config.clientId)
    ) {
      this.store.saveSecret('connector_' + config.id, undefined, true);
      this.store.saveSecret('connector_refresh_' + config.id, undefined, true);
    }
    if (secret || clearSecret)
      this.store.saveSecret('connector_refresh_' + config.id, undefined, true);
    this.store.saveSecret('connector_' + config.id, secret, clearSecret);
    const preserve =
      old?.baseUrl === config.baseUrl && old.kind === config.kind && !secret && !clearSecret;
    this.store.put('connector', {
      ...config,
      status: preserve ? old.status : 'configured',
      account: preserve ? old.account : undefined,
    });
    this.changed();
  }
  cancel(id: string) {
    this.pending.get(id)?.abort();
    this.pending.delete(id);
  }
  remove(id: string) {
    this.cancel(id);
    this.store.remove('connector', id);
    this.store.saveSecret('connector_' + id, undefined, true);
    this.store.saveSecret('connector_refresh_' + id, undefined, true);
    this.changed();
  }
  private record(c: Connector, status: Connector['status'], account?: string) {
    if (
      JSON.stringify(this.store.list<Connector>('connector').find((v) => v.id === c.id)) !==
      JSON.stringify(c)
    )
      return;
    this.store.put('connector', { ...c, status, account, checkedAt: Date.now() });
    this.store.put('authEvent', {
      id: randomUUID(),
      providerId: c.id,
      phase: status,
      time: Date.now(),
    });
    this.changed();
  }
  async test(id: string, token?: string, signal = AbortSignal.timeout(20000)) {
    const c = this.store.get<Connector>('connector', id);
    if (!c.enabled) throw new Error('连接器已停用');
    if (c.kind === 'browser')
      throw new Error('浏览器登录态请在独立窗口中检查；Cookie 存在不代表账号已认证');
    let secret = token ?? this.store.secret('connector_' + id);
    if (!secret) throw new Error('请先授权或保存访问令牌');
    const root = serviceUrl(c.baseUrl);
    const url =
      c.kind === 'github'
        ? root.hostname === 'github.com'
          ? 'https://api.github.com/user'
          : root.origin + '/api/v3/user'
        : root.origin + '/api/v4/user';
    const request = () =>
      serviceFetch(url, {
        headers: {
          Authorization: 'Bearer ' + secret,
          Accept: 'application/json',
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        redirect: 'error',
      });
    let response = await request();
    const refresh = this.store.secret('connector_refresh_' + id);
    if (response.status === 401 && !token && c.kind === 'gitlab' && refresh && c.clientId) {
      const refreshed = await serviceFetch(root.origin + '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: c.clientId,
          grant_type: 'refresh_token',
          refresh_token: refresh,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        redirect: 'error',
      });
      const result = (await refreshed.json()) as any;
      if (!refreshed.ok || !result.access_token) {
        this.record(c, 'error');
        throw new Error('授权已过期，请重新登录');
      }
      signal.throwIfAborted();
      if (JSON.stringify(this.store.get('connector', id)) !== JSON.stringify(c))
        throw new Error('连接配置已变更');
      secret = result.access_token;
      this.store.saveSecret('connector_' + id, secret);
      if (result.refresh_token)
        this.store.saveSecret('connector_refresh_' + id, result.refresh_token);
      response = await request();
    }
    if (!response.ok) {
      this.record(c, 'error');
      throw new Error(`账号验证失败（HTTP ${response.status}），请检查授权范围或有效期`);
    }
    const body = (await response.json()) as any;
    if (!body.id || !(body.login || body.username)) throw new Error('服务未返回有效账号身份');
    // Do not apply a response after the connector was changed or removed.
    if (JSON.stringify(this.store.get('connector', id)) !== JSON.stringify(c))
      throw new Error('连接配置已变更，请重新验证');
    if (token) this.store.saveSecret('connector_' + id, token);
    this.record(c, 'connected', String(body.login || body.username));
    return '已验证账号：' + String(body.login || body.username);
  }
  async login(id: string) {
    const c = this.store.get<Connector>('connector', id);
    if (c.kind === 'gitlab') {
      if (!c.enabled || !c.clientId) throw new Error('请配置 GitLab 公共 OAuth 应用 Client ID');
      this.cancel(id);
      const controller = new AbortController();
      this.pending.set(id, controller);
      return gitlabLogin(
        serviceUrl(c.baseUrl).origin,
        c.clientId,
        controller.signal,
        async (token, refresh) => {
          await this.test(id, token, controller.signal);
          controller.signal.throwIfAborted();
          if (refresh) this.store.saveSecret('connector_refresh_' + id, refresh);
        },
        () => this.record(c, 'error'),
        () => {
          if (this.pending.get(id) === controller) this.pending.delete(id);
        },
      );
    }
    if (c.kind !== 'github') throw new Error('此连接器请使用独立浏览器登录');
    if (!c.enabled || !c.clientId)
      throw new Error('请配置已启用设备授权的 GitHub OAuth App Client ID');
    this.cancel(id);
    const controller = new AbortController();
    this.pending.set(id, controller);
    const root = serviceUrl(c.baseUrl).origin;
    const request = async (endpoint: string, params: Record<string, string>) => {
      const r = await serviceFetch(root + endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params),
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      if (!r.ok) throw new Error(`授权服务返回 HTTP ${r.status}`);
      return (await r.json()) as any;
    };
    try {
      const d = await request('/login/device/code', {
        client_id: c.clientId,
        scope: 'read:user repo',
      });
      if (!d.device_code || !d.user_code || !d.verification_uri)
        throw new Error('服务未返回设备授权信息，请检查 Client ID');
      const verification = serviceUrl(d.verification_uri);
      if (verification.origin !== root) throw new Error('授权服务返回了非本站登录地址');
      const expiresAt = Date.now() + Math.min(Number(d.expires_in) || 900, 1800) * 1000;
      void (async () => {
        let interval = Math.max(5, Number(d.interval) || 5);
        while (Date.now() < expiresAt) {
          await delay(interval * 1000, undefined, { signal: controller.signal });
          const result = await request('/login/oauth/access_token', {
            client_id: c.clientId!,
            device_code: d.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          });
          if (result.access_token) {
            await this.test(id, result.access_token, controller.signal);
            return;
          }
          if (result.error === 'slow_down') interval += 5;
          else if (result.error !== 'authorization_pending') throw new Error('授权被拒绝或已过期');
        }
        throw new Error('授权已过期');
      })()
        .catch(() => {
          if (!controller.signal.aborted) this.record(c, 'error');
        })
        .finally(() => {
          if (this.pending.get(id) === controller) this.pending.delete(id);
        });
      return { url: verification.href, code: String(d.user_code), expiresAt };
    } catch (e) {
      this.cancel(id);
      throw e;
    }
  }
  dispose() {
    for (const id of this.pending.keys()) this.cancel(id);
  }
}
