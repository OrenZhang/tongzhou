import QRCode from 'qrcode';
import { z } from 'zod';
import { appFetch } from '../network/request-identity';

const endpoint = 'https://oapi.dingtalk.com/app/registration/';
// Service registration channel used by the official connector, not the execution engine.
const source = 'DING_DWS_CLAW';
const credentialsSchema = z.object({
  client_id: z.string().trim().min(1).max(200),
  client_secret: z.string().trim().min(1).max(4000),
});
type AuthState = {
  id: string;
  phase: 'waiting' | 'success' | 'expired' | 'cancelled' | 'error';
  expiresAt?: number;
};
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** First-party device registration. Credentials and device codes stay in the main process. */
export class DingtalkOnboarding {
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
  async onboard(id: string, authorized: (credentials: z.infer<typeof credentialsSchema>) => void) {
    if (this.disposed) throw new Error('机器人授权服务已关闭');
    this.cancel(id);
    const controller = new AbortController();
    this.pending.set(id, controller);
    const current = () => !this.disposed && this.pending.get(id) === controller;
    const request = async (path: 'init' | 'begin' | 'poll', body: object) => {
      controller.signal.throwIfAborted();
      const response = await this.fetcher(endpoint + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        redirect: 'error',
        cache: 'no-store',
      });
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error('钉钉授权服务暂不可用');
      const value = await response.json();
      if (!value || value.errcode !== 0) throw new Error('钉钉未返回有效授权信息');
      return value;
    };
    try {
      const init = z
        .object({ nonce: z.string().trim().min(1).max(4000) })
        .parse(await request('init', { source }));
      const begin = z
        .object({
          device_code: z.string().trim().min(1).max(4000),
          verification_uri_complete: z.string().url().max(8000),
          expires_in: z.number().positive().max(86400).default(7200),
          interval: z.number().positive().max(60).default(3),
        })
        .parse(await request('begin', { nonce: init.nonce }));
      const url = new URL(begin.verification_uri_complete);
      if (
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password ||
        !(url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com'))
      )
        throw new Error('钉钉返回了无效授权地址');
      const expiresAt = Date.now() + begin.expires_in * 1000;
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
          await delay(
            Math.min(Math.max(1000, begin.interval * 1000), expiresAt - Date.now()),
            controller.signal,
          );
          if (Date.now() >= expiresAt) break;
          let result;
          try {
            result = await request('poll', { device_code: begin.device_code });
            failures = 0;
          } catch {
            controller.signal.throwIfAborted();
            if (++failures >= 3) throw new Error('授权查询失败');
            continue;
          }
          controller.signal.throwIfAborted();
          if (!current() || Date.now() >= expiresAt) break;
          switch (String(result.status).trim().toUpperCase()) {
            case 'WAITING':
              continue;
            case 'SUCCESS':
              authorized(credentialsSchema.parse(result));
              status('success');
              return;
            case 'EXPIRED':
              status('expired');
              return;
            case 'FAIL':
              status('error');
              return;
            default:
              throw new Error('授权状态无效');
          }
        }
        status('expired');
      })()
        .catch(() => status(controller.signal.aborted ? 'cancelled' : 'error'))
        .finally(() => {
          if (current()) this.pending.delete(id);
        });
      return { id, url: url.href, image, expiresAt };
    } catch {
      if (current()) {
        this.pending.delete(id);
        controller.abort();
        this.publish({ id, phase: 'error' });
      }
      throw new Error('无法获取钉钉授权二维码，请重试或使用手动配置');
    }
  }
}
