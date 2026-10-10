import { appFetch } from '../network/request-identity';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { Channel } from '../../../src/shared/types';
import type { Store } from '../storage/store';
import type { ChangePublisher } from '../../core/task-contracts';

export const feishuHost = (domain?: string) =>
  domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
export async function feishuToken(
  appId: string,
  appSecret: string,
  domain?: string,
  signal = AbortSignal.timeout(15000),
) {
  const response = await appFetch(
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
  constructor(
    private store: Store,
    private runtime: ChangePublisher,
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
  async onboard(
    id: string,
    name: string,
    authorized?: (channel: Channel, secret: string, allowedSenders: string[]) => void,
  ) {
    this.cancel(id);
    const controller = new AbortController();
    this.pending.set(id, controller);
    let domain: 'feishu' | 'lark' = 'feishu';
    const request = async (params: Record<string, string>) => {
      const r = await appFetch(
        (domain === 'feishu' ? 'https://accounts.feishu.cn' : 'https://accounts.larksuite.com') +
          '/oauth/v1/app/registration',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
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
            const allowedSenders = result.user_info?.open_id ? [result.user_info.open_id] : [];
            const channel = {
              id,
              name,
              kind: 'feishu',
              mode: 'app',
              enabled: true,
              appId: result.client_id,
              domain,
              receiveId: result.user_info?.open_id ?? '',
              receiveIdType: 'open_id',
              status: 'authorized',
              checkedAt: Date.now(),
            } satisfies Channel;
            if (authorized) authorized(channel, result.client_secret, allowedSenders);
            else {
              this.store.saveSecret('channel_app_' + id, result.client_secret);
              this.store.put('channel', channel);
            }
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
  dispose() {
    this.disposed = true;
    for (const id of this.pending.keys()) this.cancel(id);
  }
}
