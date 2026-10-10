import QRCode from 'qrcode';
import { z } from 'zod';
import { WeixinApi, waitForWeixin, weixinApiUrl, weixinBaseUrl } from './api';

const loginSchema = z.object({
  bot_token: z.string().trim().min(1).max(4000),
  ilink_bot_id: z.string().trim().min(1).max(200),
  ilink_user_id: z.string().trim().min(1).max(200),
  baseurl: z.string().default(weixinBaseUrl).transform(weixinApiUrl),
});
type Login = z.infer<typeof loginSchema>;
type State = { id: string; phase: string; expiresAt?: number };
type Pending = {
  controller: AbortController;
  code?: string;
  needsCode?: boolean;
  expiresAt: number;
};

export class WeixinOnboarding {
  private pending = new Map<string, Pending>();
  private disposed = false;
  constructor(
    private publish: (state: State) => void,
    private api = new WeixinApi(),
  ) {}
  cancel(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.controller.abort();
    this.publish({ id, phase: 'cancelled' });
  }
  verify(id: string, code: string) {
    const pending = this.pending.get(id);
    if (!pending?.needsCode || Date.now() >= pending.expiresAt)
      throw new Error('当前无需验证码或授权已过期');
    pending.code = z
      .string()
      .regex(/^\d{4,12}$/, '请输入手机微信显示的数字验证码')
      .parse(code.trim());
    pending.needsCode = false;
    this.publish({ id, phase: 'verifying', expiresAt: pending.expiresAt });
  }
  dispose() {
    this.disposed = true;
    for (const id of this.pending.keys()) this.cancel(id);
  }
  async onboard(id: string, authorized: (login: Login) => void) {
    if (this.disposed) throw new Error('微信授权服务已关闭');
    this.cancel(id);
    const pending: Pending = { controller: new AbortController(), expiresAt: Date.now() + 300_000 };
    this.pending.set(id, pending);
    const current = () => !this.disposed && this.pending.get(id) === pending;
    const { signal } = pending.controller;
    const phase = (value: string) => {
      if (current()) this.publish({ id, phase: value, expiresAt: pending.expiresAt });
    };
    try {
      const begin = z
        .object({
          qrcode: z.string().min(1).max(8000),
          qrcode_img_content: z.string().min(1).max(8000),
        })
        .parse(
          await this.api.request(weixinBaseUrl, 'get_bot_qrcode?bot_type=3', signal, {
            body: { local_token_list: [] },
          }),
        );
      const image = await QRCode.toDataURL(begin.qrcode_img_content, { width: 256, margin: 2 });
      signal.throwIfAborted();
      phase('waiting');
      void (async () => {
        let baseUrl = weixinBaseUrl,
          failures = 0,
          redirects = 0;
        while (current() && Date.now() < pending.expiresAt) {
          await waitForWeixin(1000, signal);
          if (Date.now() >= pending.expiresAt) break;
          if (pending.needsCode) continue;
          const code = pending.code;
          let result;
          try {
            result = await this.api.request(
              baseUrl,
              'get_qrcode_status?qrcode=' +
                encodeURIComponent(begin.qrcode) +
                (code ? '&verify_code=' + encodeURIComponent(code) : ''),
              signal,
              { timeout: 35_000 },
            );
            failures = 0;
          } catch {
            signal.throwIfAborted();
            if (++failures >= 5) throw new Error('微信授权查询失败');
            continue;
          }
          signal.throwIfAborted();
          if (!current() || Date.now() >= pending.expiresAt) break;
          if (result.status === 'confirmed') {
            authorized(loginSchema.parse(result));
            phase('success');
            return;
          }
          if (result.status === 'expired') {
            phase('expired');
            return;
          }
          if (result.status === 'binded_redirect') {
            phase('already_bound');
            return;
          }
          if (result.status === 'verify_code_blocked') {
            phase('verify_blocked');
            return;
          }
          if (result.status === 'need_verifycode') {
            pending.needsCode = true;
            pending.code = undefined;
            phase(code ? 'verify_invalid' : 'verify_required');
          } else if (result.status === 'scaned') {
            pending.code = undefined;
            phase('scanned');
          } else if (result.status === 'scaned_but_redirect') {
            if (typeof result.redirect_host !== 'string' || ++redirects > 3)
              throw new Error('微信授权跳转无效');
            baseUrl = weixinApiUrl('https://' + result.redirect_host);
          } else if (result.status !== 'wait') throw new Error('未知微信授权状态');
        }
        phase('expired');
      })()
        .catch(() => phase(signal.aborted ? 'cancelled' : 'error'))
        .finally(() => {
          if (current()) this.pending.delete(id);
        });
      return { id, url: begin.qrcode_img_content, image, expiresAt: pending.expiresAt };
    } catch {
      if (current()) {
        this.pending.delete(id);
        pending.controller.abort();
        this.publish({ id, phase: 'error' });
      }
      throw new Error('无法获取微信授权二维码，请稍后重试');
    }
  }
}
