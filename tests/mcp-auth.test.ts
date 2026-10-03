import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Store } from '../electron/store';
import { McpAuth, PluginOAuthProvider, mcpRedirect, oauthFetch } from '../electron/mcp-auth';
import type { PluginConfig } from '../src/shared/types';
import { serviceFetch, setServiceTransport } from '../electron/service-network';
const cleanups: (() => any)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  setServiceTransport();
});
it('uses the injected desktop transport for OAuth with cookies omitted and redirects blocked', async () => {
  const transport = vi.fn(async () => new Response('{}'));
  setServiceTransport(transport as typeof fetch);
  await oauthFetch('https://auth.example.com/token', {
    method: 'POST',
    body: 'fixture',
    credentials: 'include',
  });
  expect(transport.mock.calls[0]).toMatchObject([
    'https://auth.example.com/token',
    { method: 'POST', credentials: 'omit', redirect: 'error' },
  ]);
});
it('negotiates confidential dynamic clients and encrypts pre-registered application secrets', () => {
  const s = store();
  s.put('plugin', plugin);
  const p = new PluginOAuthProvider(s, plugin);
  p.saveDiscoveryState({
    authorizationServerUrl: 'https://auth.example.com',
    authorizationServerMetadata: {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    },
  });
  expect(p.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
  const registered = {
    ...plugin,
    oauthClientId: 'my-client',
    oauthIssuer: 'https://auth.example.com',
  };
  s.put('plugin', registered);
  s.saveSecret('plugin_oauth_client_' + plugin.id, 'fixture-app-secret');
  expect(new PluginOAuthProvider(s, registered).clientInformation()).toMatchObject({
    client_id: 'my-client',
    client_secret: 'fixture-app-secret',
    issuer: registered.oauthIssuer,
  });
  expect(JSON.stringify(s.list('plugin'))).not.toContain('fixture-app-secret');
});
it('reports GitHub registration requirements before opening a browser or binding a callback port', async () => {
  const s = store();
  s.put('plugin', { ...plugin, url: 'https://api.githubcopilot.com/mcp/' });
  const open = vi.fn(),
    request = vi.fn();
  const service = new McpAuth(s, () => {}, open, request);
  cleanups.push(() => service.dispose());
  await expect(service.login(plugin.id)).rejects.toThrow('Client ID 和 Client Secret');
  expect(open).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(s.get<PluginConfig>('plugin', plugin.id)).toMatchObject({
    oauthStatus: 'error',
    oauthError: expect.stringContaining('不支持自动注册'),
  });
});
it('reports Figma registration rejection with an actionable error without leaking a response body', async () => {
  const s = store();
  s.put('plugin', { ...plugin, url: 'https://mcp.figma.com/mcp' });
  const seen: string[] = [];
  setServiceTransport(async (input, init) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('oauth-protected-resource'))
      return new Response(
        JSON.stringify({
          resource: 'https://mcp.figma.com/mcp',
          authorization_servers: ['https://api.figma.com'],
        }),
      );
    if (url.includes('.well-known/oauth-authorization-server'))
      return new Response(
        JSON.stringify({
          issuer: 'https://api.figma.com',
          authorization_endpoint: 'https://www.figma.com/oauth/mcp',
          token_endpoint: 'https://api.figma.com/v1/oauth/token',
          registration_endpoint: 'https://api.figma.com/v1/oauth/mcp/register',
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }),
      );
    expect(JSON.parse(String(init?.body)).token_endpoint_auth_method).toBe('client_secret_post');
    return new Response('Forbidden fixture-private-response', { status: 403 });
  });
  const open = vi.fn();
  const service = new McpAuth(s, () => {}, open);
  cleanups.push(() => service.dispose());
  await expect(service.login(plugin.id)).rejects.toThrow('Figma 拒绝客户端注册（HTTP 403）');
  expect(seen).toContain('https://api.figma.com/v1/oauth/mcp/register');
  expect(open).not.toHaveBeenCalled();
  expect(JSON.stringify(s.list('plugin'))).not.toContain('fixture-private-response');
  expect(s.get<PluginConfig>('plugin', plugin.id).oauthError).toContain('桌面 MCP');
});
it('returns a manual authorization link when opening the system browser fails and permits cancellation', async () => {
  const s = store();
  s.put('plugin', plugin);
  const service = new McpAuth(
    s,
    () => {},
    async () => {
      throw new Error('no default browser');
    },
    async (provider) => {
      const url = new URL('https://auth.example.com/authorize');
      url.searchParams.set('state', await provider.state!());
      await provider.redirectToAuthorization(url);
      return 'REDIRECT';
    },
  );
  cleanups.push(() => service.dispose());
  const result = await service.login(plugin.id);
  expect(result.browserOpened).toBe(false);
  expect(result.url).toContain('https://auth.example.com/authorize');
  expect(s.get<PluginConfig>('plugin', plugin.id).oauthStatus).toBe('waiting');
  service.cancel(plugin.id);
  expect(s.get<PluginConfig>('plugin', plugin.id).oauthStatus).toBe('cancelled');
});
it('replaces stale waiting status after restart with a retryable error', () => {
  const s = store();
  s.put('plugin', { ...plugin, oauthStatus: 'waiting' });
  const service = new McpAuth(
    s,
    () => {},
    async () => {},
  );
  cleanups.push(() => service.dispose());
  expect(s.get<PluginConfig>('plugin', plugin.id)).toMatchObject({
    oauthStatus: 'error',
    oauthError: expect.stringContaining('已中断'),
  });
});
function store() {
  const s = new Store(':memory:', {
    encrypt: (v) => Buffer.from(v).toString('base64'),
    decrypt: (v) => Buffer.from(v, 'base64').toString(),
  });
  cleanups.push(() => s.close());
  return s;
}
const plugin: PluginConfig = {
  id: 'oauth',
  name: 'Fixture',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  command: '',
  args: [],
  readOnlyTools: [],
  enabled: true,
  authMode: 'oauth',
};
it.each(['none', 'client_secret_post'])(
  'completes SDK discovery, %s registration, PKCE exchange, state validation and token refresh against a local fixture',
  async (authMethod) => {
    let origin = '',
      challenge = '',
      refreshes = 0;
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const u = new URL(req.url!, origin);
      res.setHeader('Content-Type', 'application/json');
      if (u.pathname === '/.well-known/oauth-protected-resource/mcp')
        res.end(JSON.stringify({ resource: origin + '/mcp', authorization_servers: [origin] }));
      else if (u.pathname === '/.well-known/oauth-authorization-server')
        res.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: origin + '/authorize',
            token_endpoint: origin + '/token',
            registration_endpoint: origin + '/register',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: [authMethod],
          }),
        );
      else if (u.pathname === '/register') {
        const body = JSON.parse(raw);
        expect(body.token_endpoint_auth_method).toBe(authMethod);
        res.writeHead(201);
        res.end(
          JSON.stringify({
            ...body,
            client_id: 'fixture-client',
            ...(authMethod === 'none' ? {} : { client_secret: 'fixture-client-secret' }),
          }),
        );
      } else if (u.pathname === '/token') {
        const params = new URLSearchParams(raw);
        if (authMethod === 'client_secret_post')
          expect(params.get('client_secret')).toBe('fixture-client-secret');
        if (params.get('grant_type') === 'refresh_token') {
          expect(params.get('refresh_token')).toBe('fixture-refresh');
          refreshes++;
        } else {
          expect(params.get('code')).toBe('fixture-code');
          expect(
            createHash('sha256').update(params.get('code_verifier')!).digest('base64url'),
          ).toBe(challenge);
          expect(params.get('redirect_uri')).toBe(mcpRedirect);
        }
        res.end(
          JSON.stringify({
            access_token: refreshes ? 'fixture-access-refreshed' : 'fixture-access',
            refresh_token: 'fixture-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + (server.address() as any).port;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const s = store();
    const p = { ...plugin, url: origin + '/mcp' };
    s.put('plugin', p);
    let opened = '';
    const service = new McpAuth(
      s,
      () => {},
      async (url) => {
        opened = url;
      },
    );
    cleanups.push(() => service.dispose());
    await service.login(p.id);
    expect(s.get<PluginConfig>('plugin', p.id).oauthStatus).toBe('waiting');
    const login = new URL(opened);
    expect(login.pathname).toBe('/authorize');
    expect(login.searchParams.get('code_challenge_method')).toBe('S256');
    challenge = login.searchParams.get('code_challenge')!;
    const wrong = await fetch(mcpRedirect + '?code=fixture-code&state=wrong');
    expect(wrong.status).toBe(400);
    const callback = new URL(mcpRedirect);
    callback.searchParams.set('state', login.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    const result = await fetch(callback);
    expect(result.status).toBe(200);
    expect(await result.text()).toContain('已保存');
    expect(s.get<PluginConfig>('plugin', p.id).oauthStatus).toBe('authorized');
    expect(JSON.stringify(s.list('plugin'))).not.toContain('fixture-access');
    const provider = new PluginOAuthProvider(s, p);
    expect(provider.tokens()?.issuer).toBe(origin);
    expect(() => provider.codeVerifier()).toThrow('已过期');
    await auth(provider, { serverUrl: p.url, fetchFn: oauthFetch });
    expect(refreshes).toBe(1);
    expect(provider.tokens()?.access_token).toBe('fixture-access-refreshed');
    service.logout(p.id);
    expect(s.secret('plugin_oauth_' + p.id)).toBe('');
    expect(() => provider.saveTokens({ access_token: 'stale', token_type: 'Bearer' })).toThrow(
      '变化',
    );
  },
  15000,
);
it('isolates OAuth credentials by plugin endpoint and requires explicit UI login for redirects', async () => {
  const s = store();
  s.put('plugin', plugin);
  const p = new PluginOAuthProvider(s, plugin);
  p.saveTokens({
    access_token: 'private-token',
    token_type: 'Bearer',
    issuer: 'https://auth.example.com',
  });
  await expect(
    p.redirectToAuthorization(new URL('https://auth.example.com/authorize')),
  ).rejects.toThrow('插件与工具');
  s.put('plugin', { ...plugin, url: 'https://other.example.com/mcp' });
  expect(() => p.tokens()).toThrow('变化');
  expect(() =>
    new PluginOAuthProvider(s, { ...plugin, url: 'https://other.example.com/mcp' }).tokens(),
  ).toThrow('不匹配');
  await expect(oauthFetch('http://remote.example.com/token')).rejects.toThrow('HTTPS');
});
