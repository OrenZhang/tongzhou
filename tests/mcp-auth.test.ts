import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Store } from '../electron/store';
import { McpAuth, PluginOAuthProvider, mcpRedirect, oauthFetch } from '../electron/mcp-auth';
import type { PluginConfig } from '../src/shared/types';
const cleanups: (() => any)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
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
it('completes SDK discovery, registration, PKCE exchange, state validation and token refresh against a local fixture', async () => {
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
          token_endpoint_auth_methods_supported: ['none'],
        }),
      );
    else if (u.pathname === '/register') {
      const body = JSON.parse(raw);
      res.writeHead(201);
      res.end(JSON.stringify({ ...body, client_id: 'fixture-client' }));
    } else if (u.pathname === '/token') {
      const params = new URLSearchParams(raw);
      if (params.get('grant_type') === 'refresh_token') {
        expect(params.get('refresh_token')).toBe('fixture-refresh');
        refreshes++;
      } else {
        expect(params.get('code')).toBe('fixture-code');
        expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(
          challenge,
        );
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
}, 15000);
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
  ).rejects.toThrow('连接中心');
  s.put('plugin', { ...plugin, url: 'https://other.example.com/mcp' });
  expect(() => p.tokens()).toThrow('变化');
  expect(() =>
    new PluginOAuthProvider(s, { ...plugin, url: 'https://other.example.com/mcp' }).tokens(),
  ).toThrow('不匹配');
  await expect(oauthFetch('http://remote.example.com/token')).rejects.toThrow('HTTPS');
});
