import type { CodexAuthState, CodexLoginMethod } from '../src/shared/types';
import type { CodexClient } from './codex';
import { redact } from './validation';

export function loginUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Codex 返回了不受信任的登录地址');
  return url.href;
}

// Own the managed login ceremony; never extract or relay OAuth access/refresh tokens.
export class CodexAuth {
  private state: CodexAuthState = { available: false, account: '' };
  private loginId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private reading?: Promise<CodexAuthState>;
  private completing?: Promise<void>;
  private early = new Map<string, any>();
  private epoch = 0;
  private disposed = false;
  constructor(
    private client: Pick<CodexClient, 'start' | 'request' | 'stop'> & {
      on(event: string, listener: (...args: any[]) => void): unknown;
    },
    private open: (url: string) => Promise<void>,
    private changed: (state: CodexAuthState) => void,
    private onSignedIn: () => Promise<void> = async () => {},
  ) {
    client.on('notification', ({ method, params }) => {
      if (this.disposed) return;
      if (method === 'account/login/completed') {
        if (params.loginId === this.loginId && this.loginId) this.complete(params);
        else if (this.state.login?.phase === 'starting' && params.loginId)
          this.early.set(params.loginId, params);
      }
      if (method === 'account/updated') void this.read();
    });
    client.on('failure', (error: Error) => {
      if (this.disposed) return;
      if (this.state.login?.phase === 'waiting' || this.state.login?.phase === 'starting')
        this.fail(error);
    });
  }
  snapshot(): CodexAuthState {
    return structuredClone(this.state);
  }
  private publish() {
    if (!this.disposed) this.changed(this.snapshot());
  }
  private clearPending() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.loginId = undefined;
    this.early.clear();
  }
  private fail(error: unknown) {
    this.clearPending();
    if (this.state.login)
      this.state.login = {
        method: this.state.login.method,
        phase: 'error',
        error: redact(error instanceof Error ? error.message : String(error)),
      };
    this.publish();
  }
  async read(): Promise<CodexAuthState> {
    if (this.disposed) return this.snapshot();
    if (this.reading) return this.reading;
    const epoch = this.epoch;
    this.reading = (async () => {
      try {
        await this.client.start();
        const result = await this.client.request('account/read', { refreshToken: false });
        if (epoch !== this.epoch || this.disposed) return this.snapshot();
        this.state = {
          ...this.state,
          available: true,
          account: result.account?.email ?? result.account?.type ?? '',
          plan: result.account?.planType ?? undefined,
          error: undefined,
        };
      } catch (e) {
        if (epoch !== this.epoch || this.disposed) return this.snapshot();
        this.state = {
          ...this.state,
          available: false,
          account: '',
          error: redact(e instanceof Error ? e.message : String(e)),
        };
      }
      this.publish();
      return this.snapshot();
    })();
    try {
      return await this.reading;
    } finally {
      this.reading = undefined;
    }
  }
  async start(method: CodexLoginMethod): Promise<CodexAuthState> {
    if (['starting', 'waiting'].includes(this.state.login?.phase ?? '') || this.completing)
      throw new Error('已有授权正在进行，请先完成或取消当前授权');
    const epoch = ++this.epoch;
    this.state.login = { method, phase: 'starting' };
    this.publish();
    try {
      await this.client.start();
      if (epoch !== this.epoch || this.disposed) return this.snapshot();
      const result = await this.client.request('account/login/start', {
        type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt',
      });
      if (epoch !== this.epoch || this.disposed) {
        if (result.loginId)
          await this.client
            .request('account/login/cancel', { loginId: result.loginId })
            .catch(() => {});
        return this.snapshot();
      }
      if (!result.loginId || typeof result.loginId !== 'string')
        throw new Error('Codex 未返回有效登录会话');
      this.loginId = result.loginId;
      const url = loginUrl(method === 'device' ? result.verificationUrl : result.authUrl);
      if (method === 'device' && (typeof result.userCode !== 'string' || !result.userCode))
        throw new Error('Codex 未返回设备授权码');
      this.state.available = true;
      this.state.login = {
        method,
        phase: 'waiting',
        url,
        ...(method === 'device' ? { userCode: result.userCode } : {}),
      };
      this.timer = setTimeout(
        () => {
          if (epoch !== this.epoch) return;
          void this.cancel()
            .catch(() => {})
            .then(() => {
              if (this.epoch === epoch + 1) this.fail(new Error('授权等待超时，请重新发起登录'));
            });
        },
        10 * 60 * 1000,
      );
      this.publish();
      const completed = this.early.get(result.loginId);
      this.early.clear();
      if (completed) this.complete(completed);
      if (method === 'browser' && this.state.login.phase === 'waiting') {
        try {
          await this.open(url);
        } catch {
          if (epoch === this.epoch && this.state.login?.phase === 'waiting') {
            this.state.login.error = '无法自动打开浏览器，请点击“打开授权页面”重试。';
            this.publish();
          }
        }
      }
    } catch (e) {
      if (epoch !== this.epoch || this.disposed) return this.snapshot();
      const id = this.loginId;
      if (id) await this.client.request('account/login/cancel', { loginId: id }).catch(() => {});
      else this.client.stop(); // A timed-out start may still own a callback listener.
      this.fail(e);
    }
    return this.snapshot();
  }
  private complete(params: any) {
    const method = this.state.login!.method;
    const epoch = this.epoch;
    this.clearPending();
    if (!params.success) {
      this.fail(new Error(params.error || '授权未完成，请重试'));
      return;
    }
    this.state.login = { method, phase: 'checking' };
    this.publish();
    this.completing = (async () => {
      if (this.reading) await this.reading;
      const current = await this.read();
      if (epoch !== this.epoch) return;
      if (!current.account) {
        this.fail(new Error(current.error || '授权已返回，但尚未读取到账号，请刷新或重新登录'));
        return;
      }
      this.state.login = { method, phase: 'success' };
      this.publish();
      await this.onSignedIn().catch(() => {});
    })().finally(() => {
      this.completing = undefined;
    });
  }
  async cancel() {
    ++this.epoch;
    const id = this.loginId;
    const wasStarting = this.state.login?.phase === 'starting';
    this.clearPending();
    if (this.state.login)
      this.state.login = { method: this.state.login.method, phase: 'cancelled' };
    this.publish();
    if (id) await this.client.request('account/login/cancel', { loginId: id });
    else if (wasStarting) this.client.stop();
  }
  async restart(method: CodexLoginMethod) {
    await this.cancel();
    if (this.completing) await this.completing;
    return this.start(method);
  }
  async openPage() {
    if (this.state.login?.phase !== 'waiting' || !this.state.login.url)
      throw new Error('当前没有待完成的授权');
    await this.open(loginUrl(this.state.login.url));
  }
  code() {
    if (this.state.login?.phase !== 'waiting' || !this.state.login.userCode)
      throw new Error('当前没有有效设备码');
    return this.state.login.userCode;
  }
  async logout() {
    ++this.epoch;
    await this.cancel();
    await this.client.start();
    await this.client.request('account/logout', {});
    this.state = { available: true, account: '' };
    this.publish();
  }
  dispose() {
    this.disposed = true;
    ++this.epoch;
    this.clearPending();
  }
}
