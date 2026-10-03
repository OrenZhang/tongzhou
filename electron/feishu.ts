import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { WSClient, EventDispatcher, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { Channel, Session } from '../src/shared/types';
import type { Store } from './store';
import type { Runtime } from './runtime';

export const feishuHost = (domain?: string) =>
  domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
export async function feishuToken(
  appId: string,
  appSecret: string,
  domain?: string,
  signal = AbortSignal.timeout(15000),
) {
  const response = await fetch(
    feishuHost(domain) + '/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal,
      redirect: 'error',
    },
  );
  const result = (await response.json()) as any;
  if (!response.ok || result.code !== 0 || !result.tenant_access_token)
    throw new Error('飞书未验证应用凭据，请检查应用状态');
  return String(result.tenant_access_token);
}
export class Feishu {
  private disposed = false;
  private pending = new Map<string, AbortController>();
  private clients = new Map<string, { client: WSClient; signature: string }>();
  constructor(
    private store: Store,
    private runtime: Runtime,
  ) {}
  cancel(id: string) {
    const existed = this.pending.has(id);
    this.pending.get(id)?.abort();
    this.pending.delete(id);
    if (existed && !this.disposed) {
      this.store.put('channelAuth', { id, phase: 'cancelled' });
      this.runtime.changed();
    }
  }
  async onboard(id: string, name: string) {
    this.cancel(id);
    const controller = new AbortController();
    this.pending.set(id, controller);
    let domain: 'feishu' | 'lark' = 'feishu';
    const request = async (params: Record<string, string>) => {
      const r = await fetch(
        (domain === 'feishu' ? 'https://accounts.feishu.cn' : 'https://accounts.larksuite.com') +
          '/oauth/v1/app/registration',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Tongzhou/0.4',
          },
          body: new URLSearchParams(params),
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        },
      );
      const body = (await r.json()) as any;
      if (!r.ok && !body.error) throw new Error('飞书授权服务暂不可用');
      return body;
    };
    try {
      const init = await request({ action: 'init' });
      if (!init.supported_auth_methods?.includes('client_secret'))
        throw new Error('当前平台尚未开放扫码创建机器人，请使用高级配置');
      const begin = await request({
        action: 'begin',
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id',
      });
      const url = new URL(begin.verification_uri_complete);
      if (
        url.protocol !== 'https:' ||
        !['feishu.cn', 'larksuite.com'].some(
          (host) => url.hostname === host || url.hostname.endsWith('.' + host),
        ) ||
        !begin.device_code
      )
        throw new Error('飞书返回了无效授权地址');
      const expiresAt = Date.now() + Math.min(1800, Number(begin.expire_in) || 600) * 1000;
      const saveStatus = (phase: string) => {
        if (this.disposed || this.pending.get(id) !== controller) return;
        this.store.put('channelAuth', { id, phase, expiresAt });
        this.runtime.changed();
      };
      saveStatus('waiting');
      void (async () => {
        let interval = Math.max(5, Number(begin.interval) || 5);
        while (Date.now() < expiresAt) {
          await delay(interval * 1000, undefined, { signal: controller.signal });
          const result = await request({ action: 'poll', device_code: begin.device_code });
          if (result.user_info?.tenant_brand === 'lark' && domain !== 'lark') {
            domain = 'lark';
            continue;
          }
          if (result.client_id && result.client_secret) {
            await feishuToken(result.client_id, result.client_secret, domain, controller.signal);
            controller.signal.throwIfAborted();
            this.store.saveSecret('channel_app_' + id, result.client_secret);
            this.store.put('channel', {
              id,
              name,
              kind: 'feishu',
              mode: 'app',
              enabled: true,
              appId: result.client_id,
              domain,
              receiveId: result.user_info?.open_id ?? '',
              receiveIdType: 'open_id',
              allowedSenders: result.user_info?.open_id ? [result.user_info.open_id] : [],
              inbound: false,
              status: 'authorized',
              checkedAt: Date.now(),
            } satisfies Channel);
            this.store.put('authEvent', {
              id: randomUUID(),
              providerId: id,
              phase: 'authorized',
              time: Date.now(),
            });
            saveStatus('success');
            return;
          }
          if (result.error === 'slow_down') interval += 5;
          else if (result.error && result.error !== 'authorization_pending')
            throw new Error('授权已拒绝或过期');
        }
        throw new Error('授权已过期');
      })()
        .catch(() => saveStatus(controller.signal.aborted ? 'cancelled' : 'error'))
        .finally(() => {
          if (this.pending.get(id) === controller) this.pending.delete(id);
        });
      return {
        id,
        url: url.href,
        image: await QRCode.toDataURL(url.href, { width: 256, margin: 2 }),
        expiresAt,
      };
    } catch (e) {
      this.cancel(id);
      throw e;
    }
  }
  /** An incoming message is only accepted for an explicit binding and sender allowlist. */
  async receive(channelId: string, event: any) {
    const c = this.store.list<Channel>('channel').find((x) => x.id === channelId);
    if (!c?.enabled || !c.inbound || !c.sessionId || !c.allowedSenders?.length) return;
    const m = event.message,
      sender = event.sender?.sender_id?.open_id;
    if (
      event.sender?.sender_type !== 'user' ||
      !c.allowedSenders.includes(sender) ||
      m?.message_type !== 'text' ||
      !m.message_id
    )
      return;
    if (c.receiveIdType === 'chat_id' && m.chat_id !== c.receiveId) return;
    if (c.receiveIdType !== 'chat_id' && m.chat_type !== 'p2p') return;
    const key = channelId + ':' + m.message_id;
    if (this.store.list<any>('channelInbox').some((x) => x.id === key)) return;
    const text = JSON.parse(m.content).text;
    if (typeof text !== 'string' || !text.trim() || text.length > 10000) return;
    const s = this.store.get<Session>('session', c.sessionId);
    if (s.archived || !s.model) return;
    // Persist before enqueue, so a reconnect cannot replay a remote command.
    this.store.put('channelInbox', {
      id: key,
      sessionId: s.id,
      channelId,
      time: Date.now(),
      status: 'accepted',
    });
    try {
      await this.runtime.enqueue(
        {
          sessionId: s.id,
          providerId: s.providerId,
          model: s.model,
          agentId: s.agentId,
          prompt: `[来自飞书渠道 ${c.name} 的用户消息]\n${text}`,
        },
        'supplement',
      );
    } catch {
      this.store.put('channelInbox', {
        id: key,
        sessionId: s.id,
        channelId,
        time: Date.now(),
        status: 'paused',
      });
    }
  }
  sync() {
    const configs = this.store
      .list<Channel>('channel')
      .filter(
        (c) =>
          c.kind === 'feishu' &&
          c.mode === 'app' &&
          c.enabled &&
          c.inbound &&
          c.sessionId &&
          c.allowedSenders?.length,
      );
    for (const [id, entry] of this.clients)
      if (!configs.some((c) => c.id === id && JSON.stringify(c) === entry.signature)) {
        entry.client.close({ force: true });
        this.clients.delete(id);
      }
    for (const c of configs)
      if (!this.clients.has(c.id)) {
        const client = new WSClient({
          appId: c.appId!,
          appSecret: this.store.secret('channel_app_' + c.id),
          domain: c.domain === 'lark' ? Domain.Lark : Domain.Feishu,
          loggerLevel: LoggerLevel.error,
          logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
        });
        this.clients.set(c.id, { client, signature: JSON.stringify(c) });
        void client
          .start({
            eventDispatcher: new EventDispatcher({}).register({
              'im.message.receive_v1': (data) => this.receive(c.id, data).catch(() => {}),
            }),
          })
          .catch(() => {
            if (this.disposed || this.clients.get(c.id)?.client !== client) return;
            this.store.put('channelAuth', { id: c.id, phase: 'inbound-error' });
            this.runtime.changed();
          });
      }
  }
  dispose() {
    this.disposed = true;
    for (const id of this.pending.keys()) this.cancel(id);
    for (const { client } of this.clients.values()) client.close({ force: true });
    this.clients.clear();
  }
}
