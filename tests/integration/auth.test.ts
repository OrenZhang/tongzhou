import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CodexAuth, loginUrl } from '../../electron/services/accounts/codex-auth';

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});
function fixture() {
  let account: any = null;
  const client = Object.assign(new EventEmitter(), {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    request: vi.fn(async (method: string, params: any): Promise<any> => {
      if (method === 'account/read') return { account };
      if (method === 'account/login/start')
        return params.type === 'chatgptDeviceCode'
          ? {
              type: 'chatgptDeviceCode',
              loginId: 'device',
              verificationUrl: 'https://auth.openai.com/codex/device',
              userCode: 'TEST-0000',
            }
          : {
              type: 'chatgpt',
              loginId: 'browser',
              authUrl: 'https://chatgpt.com/auth/login?fixture=true',
            };
      if (method === 'account/logout') account = null;
      return {};
    }),
  });
  const open = vi.fn(async () => {});
  const changed = vi.fn();
  const synced = vi.fn(async () => {});
  const auth = new CodexAuth(client, open, changed, synced);
  disposals.push(() => auth.dispose());
  return {
    auth,
    client,
    open,
    changed,
    synced,
    setAccount: () => {
      account = { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' };
    },
  };
}
describe('managed ChatGPT authorization', () => {
  it('accepts both official login hosts and rejects credential-bearing or lookalike URLs', () => {
    expect(loginUrl('https://chatgpt.com/auth/login')).toContain('chatgpt.com');
    expect(loginUrl('https://auth.openai.com/codex/device')).toContain('auth.openai.com');
    for (const url of [
      'http://chatgpt.com',
      'https://chatgpt.com.evil.test',
      'https://auth.openai.com@evil.test',
      'https://user:pass@chatgpt.com',
      'https://chatgpt.com:8443',
    ])
      expect(() => loginUrl(url)).toThrow();
  });
  it('opens browser auth and waits for verified completion before announcing success', async () => {
    const f = fixture();
    await f.auth.start('browser');
    expect(f.open).toHaveBeenCalledWith('https://chatgpt.com/auth/login?fixture=true');
    expect(f.auth.snapshot().login?.phase).toBe('waiting');
    f.setAccount();
    f.client.emit('notification', {
      method: 'account/login/completed',
      params: { loginId: 'browser', success: true },
    });
    await expect.poll(() => f.auth.snapshot().login?.phase).toBe('success');
    expect(f.auth.snapshot()).toMatchObject({ account: 'fixture@example.test', plan: 'plus' });
    expect(f.synced).toHaveBeenCalledOnce();
    expect(f.auth.snapshot().login?.url).toBeUndefined();
  });
  it('returns a device code, supports reopen and cancel, and ignores late completion', async () => {
    const f = fixture();
    await f.auth.start('device');
    expect(f.client.request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgptDeviceCode',
    });
    expect(f.auth.code()).toBe('TEST-0000');
    expect(f.open).not.toHaveBeenCalled();
    await f.auth.openPage();
    expect(f.open).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
    await expect(f.auth.start('browser')).rejects.toThrow('正在进行');
    await f.auth.cancel();
    expect(f.client.request).toHaveBeenCalledWith('account/login/cancel', { loginId: 'device' });
    expect(() => f.auth.code()).toThrow();
    f.client.emit('notification', {
      method: 'account/login/completed',
      params: { loginId: 'device', success: true },
    });
    expect(f.auth.snapshot().login?.phase).toBe('cancelled');
  });
  it('surfaces provider errors and clears sensitive one-time login fields', async () => {
    const f = fixture();
    await f.auth.start('device');
    f.client.emit('notification', {
      method: 'account/login/completed',
      params: { loginId: 'device', success: false, error: 'Device code expired' },
    });
    expect(f.auth.snapshot().login).toEqual({
      method: 'device',
      phase: 'error',
      error: 'Device code expired',
    });
  });
  it('handles completion arriving before the start response', async () => {
    const f = fixture();
    const original = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementation(async (method, params) => {
      if (method === 'account/login/start') {
        f.setAccount();
        f.client.emit('notification', {
          method: 'account/login/completed',
          params: { loginId: 'browser', success: true },
        });
      }
      return original(method, params);
    });
    await f.auth.start('browser');
    await expect.poll(() => f.auth.snapshot().login?.phase).toBe('success');
  });
  it('does not report success when credentials are not readable by the engine', async () => {
    const f = fixture();
    await f.auth.start('browser');
    f.client.emit('notification', {
      method: 'account/login/completed',
      params: { loginId: 'browser', success: true },
    });
    await expect.poll(() => f.auth.snapshot().login?.phase).toBe('error');
    expect(f.synced).not.toHaveBeenCalled();
  });
  it('retains a recoverable pending flow if the system browser cannot open', async () => {
    const f = fixture();
    f.open.mockRejectedValueOnce(new Error('no browser'));
    await f.auth.start('browser');
    expect(f.auth.snapshot().login).toMatchObject({
      phase: 'waiting',
      error: expect.stringContaining('无法自动打开'),
    });
    await f.auth.openPage();
    expect(f.open).toHaveBeenCalledTimes(2);
  });
  it('expires pending login and sends cancellation to the engine', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.auth.start('device');
    await vi.advanceTimersByTimeAsync(600001);
    expect(f.auth.snapshot().login).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('超时'),
    });
    expect(f.client.request).toHaveBeenCalledWith('account/login/cancel', { loginId: 'device' });
  });
  it('cancels a browser flow before requesting a fresh device authorization', async () => {
    const f = fixture();
    await f.auth.start('browser');
    await f.auth.restart('device');
    expect(f.auth.snapshot().login).toMatchObject({
      method: 'device',
      phase: 'waiting',
      userCode: 'TEST-0000',
    });
    const calls = f.client.request.mock.calls;
    const cancelled = calls.findIndex(([m]) => m === 'account/login/cancel');
    const device = calls.findIndex(
      ([m, p]) => m === 'account/login/start' && p.type === 'chatgptDeviceCode',
    );
    expect(cancelled).toBeLessThan(device);
  });
  it('does not resurrect an authorization cancelled while its start request is pending', async () => {
    const f = fixture();
    let release!: (v: any) => void;
    const original = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementation((m, p) =>
      m === 'account/login/start'
        ? new Promise((r) => {
            release = r;
          })
        : original(m, p),
    );
    const starting = f.auth.start('browser');
    await Promise.resolve();
    await f.auth.cancel();
    release({ loginId: 'late', authUrl: 'https://auth.openai.com/oauth/authorize' });
    await starting;
    expect(f.auth.snapshot().login?.phase).toBe('cancelled');
    expect(f.open).not.toHaveBeenCalled();
    expect(f.client.request).toHaveBeenCalledWith('account/login/cancel', { loginId: 'late' });
  });
  it('does not publish a late successful verification after cancellation', async () => {
    const f = fixture();
    await f.auth.start('device');
    let release!: (v: any) => void;
    const original = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementation((m, p) =>
      m === 'account/read'
        ? new Promise((r) => {
            release = r;
          })
        : original(m, p),
    );
    f.client.emit('notification', {
      method: 'account/login/completed',
      params: { loginId: 'device', success: true },
    });
    await Promise.resolve();
    await f.auth.cancel();
    release({ account: { type: 'chatgpt', email: 'fixture@example.test' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.auth.snapshot().login?.phase).toBe('cancelled');
    expect(f.auth.snapshot().account).toBe('');
    expect(f.synced).not.toHaveBeenCalled();
  });
  it('cancels the flow and clears the account on logout', async () => {
    const f = fixture();
    f.setAccount();
    await f.auth.read();
    await f.auth.start('device');
    await f.auth.logout();
    expect(f.auth.snapshot()).toEqual({ available: true, account: '' });
    expect(f.client.request).toHaveBeenCalledWith('account/logout', {});
  });
});
