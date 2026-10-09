import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import {
  beginGithubDeviceLogin,
  waitForGithubDeviceToken,
} from '../../../electron/modules/plugins/github-device-auth';
import { McpAuth, PluginOAuthProvider } from '../../../electron/modules/plugins/mcp-auth';
import { Store } from '../../../electron/services/storage/store';
import { setServiceTransport } from '../../../electron/services/network/service-network';
import type { PluginConfig } from '../../../src/shared/types';
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async (_ms, _value, options) => {
    options?.signal?.throwIfAborted();
  }),
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  setServiceTransport();
});
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const grant = {
  device_code: 'fixture-device-secret',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://github.com/login/device' as const,
  expires_in: 900,
  interval: 5,
  expiresAt: Date.now() + 900000,
};
const tokens = {
  access_token: 'fixture-access-secret',
  refresh_token: 'fixture-refresh-secret',
  token_type: 'Bearer',
  expires_in: 28800,
};
const plugin: PluginConfig = {
  id: 'github',
  name: 'GitHub',
  transport: 'http',
  url: 'https://api.githubcopilot.com/mcp/',
  command: '',
  args: [],
  enabled: true,
  readOnlyTools: [],
  authMode: 'oauth',
};
function setup() {
  vi.stubEnv('TONGZHOU_GITHUB_CLIENT_ID', 'tongzhou-fixture-client');
  const store = new Store(':memory:', {
    encrypt: (v) => Buffer.from(v).toString('base64'),
    decrypt: (v) => Buffer.from(v, 'base64').toString(),
  });
  cleanups.push(() => store.close());
  store.put('plugin', plugin);
  return store;
}
function transport(options: { denied?: boolean; invalidIdentity?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe('error');
    if (url.pathname === '/login/device/code') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe('tongzhou-fixture-client');
      expect(body.has('client_secret')).toBe(false);
      return json(grant);
    }
    if (url.pathname === '/login/oauth/access_token') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.has('client_secret')).toBe(false);
      return json(tokens);
    }
    if (url.pathname === '/user') {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + tokens.access_token);
      return json(
        options.invalidIdentity
          ? { error: 'fixture-access-secret' }
          : { id: 42, login: 'fixture-user' },
      );
    }
    expect(url.href).toBe(plugin.url);
    if (options.denied) return json({}, 403);
    const body = JSON.parse(String(init?.body));
    if (body.id === undefined) return new Response(null, { status: 202 });
    return json({
      jsonrpc: '2.0',
      id: body.id,
      result:
        body.method === 'initialize'
          ? {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : { tools: [{ name: 'get_me', inputSchema: { type: 'object' } }] },
    });
  });
}
it('uses official device OAuth without a client secret and respects pending/slow_down intervals', async () => {
  const responses = [grant, { error: 'authorization_pending' }, { error: 'slow_down' }, tokens];
  const fetch = vi.fn(async (input, init) => {
    expect(String(input)).toMatch(/^https:\/\/github.com\/login\//);
    expect(new URLSearchParams(String(init?.body)).has('client_secret')).toBe(false);
    return json(responses.shift());
  });
  setServiceTransport(fetch);
  const g = await beginGithubDeviceLogin('tongzhou-fixture-client', signal());
  expect(await waitForGithubDeviceToken('tongzhou-fixture-client', g, signal())).toMatchObject(
    tokens,
  );
  expect(vi.mocked(delay).mock.calls.map((c) => c[0])).toEqual([5000, 5000, 10000]);
});
it.each(['access_denied', 'expired_token', 'device_flow_disabled'])(
  'handles %s without leaking device or token details',
  async (error) => {
    setServiceTransport(async () => json({ error, access_token: 'do-not-display' }));
    await expect(waitForGithubDeviceToken('id', grant, signal())).rejects.toThrow(/GitHub/);
  },
);
it('rejects foreign verification pages and malformed authorization data', async () => {
  setServiceTransport(async () =>
    json({ ...grant, verification_uri: 'https://evil.example/login' }),
  );
  await expect(beginGithubDeviceLogin('id', signal())).rejects.toThrow('有效的设备授权信息');
});
it('opens the browser and saves OAuth only after identity and MCP validation', async () => {
  const s = setup(),
    fetch = transport();
  setServiceTransport(fetch);
  const open = vi.fn(async () => {});
  const auth = new McpAuth(s, () => {}, open);
  cleanups.push(() => auth.dispose());
  const login = await auth.login(plugin.id);
  expect(login).toMatchObject({
    url: grant.verification_uri,
    code: grant.user_code,
    browserOpened: true,
  });
  expect(open).toHaveBeenCalledWith(grant.verification_uri);
  await expect.poll(() => s.get<PluginConfig>('plugin', plugin.id).oauthStatus).toBe('authorized');
  expect(s.get<PluginConfig>('plugin', plugin.id).oauthAccount).toBe('fixture-user');
  expect(JSON.stringify(s.list('plugin'))).not.toMatch(
    /fixture-access-secret|fixture-refresh-secret|fixture-device-secret/,
  );
  const saved = new PluginOAuthProvider(s, plugin);
  expect(saved.tokens()?.access_token).toBe(tokens.access_token);
  const restarted = new McpAuth(s, () => {}, open);
  cleanups.push(() => restarted.dispose());
  expect(s.get<PluginConfig>('plugin', plugin.id).oauthStatus).toBe('authorized');
  auth.logout(plugin.id);
  expect(s.secret('plugin_oauth_' + plugin.id)).toBe('');
  expect(s.get<PluginConfig>('plugin', plugin.id).oauthAccount).toBeUndefined();
});
it.each([{ denied: true }, { invalidIdentity: true }])(
  'does not save unverified authorization (%j)',
  async (options) => {
    const s = setup();
    setServiceTransport(transport(options));
    const auth = new McpAuth(
      s,
      () => {},
      async () => {},
    );
    cleanups.push(() => auth.dispose());
    await auth.login(plugin.id);
    await expect.poll(() => s.get<PluginConfig>('plugin', plugin.id).oauthStatus).toBe('error');
    expect(s.secret('plugin_oauth_' + plugin.id)).toBe('');
    expect(s.get<PluginConfig>('plugin', plugin.id).oauthError).not.toContain(tokens.access_token);
  },
);
it('refreshes expired device credentials without a secret and rejects a different identity', async () => {
  const s = setup();
  const p = new PluginOAuthProvider(s, plugin);
  p.saveGithubDeviceTokens({ ...tokens, expires_in: 1 }, 'tongzhou-fixture-client', 42);
  const fetch = transport();
  setServiceTransport(fetch);
  await p.prepare(signal());
  expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/login/oauth/access_token'))).toBe(
    true,
  );
  expect(p.tokens()?.access_token).toBe(tokens.access_token);
  const other = new PluginOAuthProvider(s, plugin);
  other.saveGithubDeviceTokens({ ...tokens, expires_in: 1 }, 'tongzhou-fixture-client', 99);
  await expect(other.prepare(signal())).rejects.toThrow('账号不匹配');
});
it('cancels an in-flight exchange and rejects late results and changes to application identity', async () => {
  const s = setup();
  let release: (v: Response) => void = () => {};
  const fetch = transport();
  setServiceTransport(async (u, i) =>
    String(u).endsWith('/login/oauth/access_token')
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : fetch(u, i),
  );
  const auth = new McpAuth(
    s,
    () => {},
    async () => {},
  );
  cleanups.push(() => auth.dispose());
  await auth.login(plugin.id);
  await expect.poll(() => vi.mocked(delay).mock.calls.length).toBeGreaterThan(0);
  auth.cancel(plugin.id);
  release(json(tokens));
  await Promise.resolve();
  await Promise.resolve();
  expect(s.get<PluginConfig>('plugin', plugin.id).oauthStatus).toBe('cancelled');
  expect(s.secret('plugin_oauth_' + plugin.id)).toBe('');
  const p = new PluginOAuthProvider(s, plugin);
  p.saveGithubDeviceTokens(tokens, 'tongzhou-fixture-client', 42);
  vi.stubEnv('TONGZHOU_GITHUB_CLIENT_ID', 'other-app');
  await expect(p.prepare(signal())).rejects.toThrow('重新登录');
});
