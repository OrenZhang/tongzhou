import QRCode from 'qrcode';
import { z } from 'zod';
import { appFetch, clientIdentity } from '../network/request-identity';

const origin = 'https://work.weixin.qq.com';
const lifetime = 5 * 60_000;
const credentialsSchema = z.object({
  botid: z.string().trim().min(1).max(200),
  secret: z.string().trim().min(1).max(4000),
});
type Credentials = z.infer<typeof credentialsSchema>;
type AuthState = {
  id: string;
  phase: 'waiting' | 'success' | 'expired' | 'cancelled' | 'error';
  expiresAt?: number;
};

function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 3000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Isolates the first-party /ai/qc web authorization protocol from bot transport.
 * The official @wecom/wecom-aibot-sdk opens /ai/qc/gen; that page uses
 * /generate and /query_result. Keep these web endpoints here, not in the renderer.
 */
export class WecomOnboarding {
  private pending = new Map<string, AbortController>();
  private disposed = false;

  constructor(
    private publish: (state: AuthState) => void,
    private fetcher: typeof fetch = appFetch,
  ) {}

  cancel(id: string) {
    const controller = this.pending.get(id);
    if (!controller) return;
    this.pending.delete(id);
    controller.abort();
    this.publish({ id, phase: 'cancelled' });
  }

  dispose() {
    this.disposed = true;
    for (const id of this.pending.keys()) this.cancel(id);
  }

  async onboard(id: string, authorized: (credentials: Credentials) => void) {
    if (this.disposed) throw new Error('机器人授权服务已关闭');
    this.cancel(id);
    const controller = new AbortController();
    this.pending.set(id, controller);
    const current = () => !this.disposed && this.pending.get(id) === controller;
    const request = async (path: string) => {
      const response = await this.fetcher(origin + path, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('企业微信授权服务暂不可用，请重试或使用手动配置');
      const result = await response.json();
      if (!result || (result.errcode !== undefined && result.errcode !== 0) || !result.data)
        throw new Error('企业微信未返回有效授权信息，请重试或使用手动配置');
      return result.data;
    };
    try {
      const begin = z
        .object({
          scode: z.string().min(1).max(2000),
          auth_url: z.string().url().max(8000),
        })
        .parse(await request('/ai/qc/generate?source=' + encodeURIComponent(clientIdentity.name)));
      const url = new URL(begin.auth_url);
      if (url.origin !== origin || url.username || url.password)
        throw new Error('企业微信返回了无效授权地址');
      const expiresAt = Date.now() + lifetime;
      const image = await QRCode.toDataURL(url.href, { width: 256, margin: 2 });
      controller.signal.throwIfAborted();
      if (!current()) throw new Error('授权已取消');
      const status = (phase: AuthState['phase']) => {
        if (current()) this.publish({ id, phase, expiresAt });
      };
      status('waiting');
      void (async () => {
        let failures = 0;
        while (current() && Date.now() < expiresAt) {
          await wait(controller.signal);
          if (Date.now() >= expiresAt) break;
          let result;
          try {
            result = await request('/ai/qc/query_result?scode=' + encodeURIComponent(begin.scode));
            failures = 0;
          } catch {
            controller.signal.throwIfAborted();
            if (++failures >= 3) throw new Error('授权查询失败');
            continue;
          }
          controller.signal.throwIfAborted();
          if (!current() || Date.now() >= expiresAt) break;
          if (result.status === 'success') {
            const credentials = credentialsSchema.parse(result.bot_info);
            authorized(credentials);
            status('success');
            return;
          }
          if (result.status === 'expired') {
            status('expired');
            return;
          }
          if (result.status === 'cancelled' || result.status === 'denied') {
            status('cancelled');
            return;
          }
          if (result.status === 'error') throw new Error('授权失败');
        }
        status('expired');
      })()
        .catch(() => status(controller.signal.aborted ? 'cancelled' : 'error'))
        .finally(() => {
          if (current()) this.pending.delete(id);
        });
      // Bot credentials never enter renderer IPC or authorization snapshots.
      return { id, url: url.href, image, expiresAt };
    } catch {
      if (current()) {
        this.pending.delete(id);
        controller.abort();
        this.publish({ id, phase: 'error' });
      }
      throw new Error('无法获取企业微信授权二维码，请重试或使用手动配置');
    }
  }
}
