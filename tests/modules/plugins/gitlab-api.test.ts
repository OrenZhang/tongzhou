import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitlabApiConnection } from '../../../electron/modules/plugins/gitlab-api';
import { PluginConnection, ToolScope, mcpName } from '../../../electron/core/tools/extensions';
import { verifyGithubPluginToken } from '../../../electron/modules/plugins/code-hosting';
import { setServiceTransport } from '../../../electron/services/network/service-network';
import { Store } from '../../../electron/services/storage/store';
import type { AgentProfile, PluginConfig } from '../../../src/shared/types';

const token = 'fixture-private-token';
const secret = JSON.stringify({ Authorization: 'Bearer ' + token });
const config: PluginConfig = {
  id: 'gitlab',
  name: 'GitLab',
  transport: 'http',
  command: '',
  args: [],
  url: 'https://git.example:8443/api/v4/mcp',
  authMode: 'headers',
  enabled: true,
  readOnlyTools: [],
};
const agent: AgentProfile = {
  id: 'a',
  name: 'A',
  description: '',
  instructions: '',
  providerId: '',
  model: '',
  permission: 'ask',
  maxSteps: 16,
};
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  setServiceTransport();
  vi.restoreAllMocks();
});
function fixture() {
  const requests: { url: URL; init: RequestInit }[] = [];
  const transport = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, init: init ?? {} });
    const data = url.pathname.endsWith('/user')
      ? { id: 7, username: 'fixture.user' }
      : [{ id: 42, echo: token }];
    return new Response(JSON.stringify(data), { headers: { 'x-next-page': '2' } });
  });
  setServiceTransport(transport as typeof fetch);
  return {
    transport,
    requests,
    connection: new GitlabApiConnection(config, secret),
    signal: AbortSignal.timeout(3000),
  };
}
describe('official GitLab Token API', () => {
  it('checks identity and project API permissions, uses selected instance and paginates read results', async () => {
    const f = fixture();
    await f.connection.connect(f.signal);
    expect(f.requests.map((r) => r.url.pathname)).toEqual(['/api/v4/user', '/api/v4/projects']);
    expect(f.requests[1].url.searchParams.get('per_page')).toBe('1');
    const result = await f.connection.call(
      'gitlab_api_read',
      { path: 'projects/group%2Fproject/repository/files/README.md', query: { ref: 'main' } },
      f.signal,
    );
    expect(result.text).toContain('nextPage=2');
    expect(result.text).not.toContain(token);
    for (const request of f.requests) {
      expect(request.url.origin).toBe('https://git.example:8443');
      expect(new Headers(request.init.headers).get('Authorization')).toBe('Bearer ' + token);
      expect(request.init.redirect).toBe('error');
    }
  });
  it('never interprets a Token as MCP OAuth and writes JSON only to the configured API', async () => {
    const f = fixture();
    const connection = new PluginConnection(config, secret);
    cleanup.push(() => connection.close());
    await connection.connect(f.signal);
    expect((await connection.tools(f.signal)).map((t) => t.name)).toEqual([
      'gitlab_api_read',
      'gitlab_api_write',
    ]);
    await connection.call(
      'gitlab_api_write',
      { path: 'projects/42/issues', method: 'POST', body: { title: 'Fixture' } },
      f.signal,
    );
    expect(f.requests.at(-1)?.init.body).toBe('{"title":"Fixture"}');
    expect(f.requests.some((r) => r.url.pathname.endsWith('/mcp'))).toBe(false);
  });
  it('rejects invalid/expired and restricted tokens without echoing server credentials', async () => {
    const f = fixture();
    for (const status of [401, 403, 404]) {
      f.transport.mockResolvedValueOnce(new Response(token, { status }));
      await expect(f.connection.connect(f.signal)).rejects.toThrow(
        status === 401 ? /失效/ : status === 403 ? /无权/ : /404/,
      );
    }
    f.transport.mockResolvedValueOnce(new Response('{"id":7,"username":"fixture"}'));
    f.transport.mockResolvedValueOnce(new Response(token, { status: 403 }));
    await expect(f.connection.connect(f.signal)).rejects.toThrow('无权');
    f.transport.mockResolvedValueOnce(new Response('<html>login</html>'));
    await expect(f.connection.connect(f.signal)).rejects.toThrow('身份校验');
  });
  it('blocks foreign hosts, traversal, credential endpoints and auth query overrides before sending', async () => {
    const f = fixture();
    for (const path of [
      'https://evil.example/projects',
      '//evil.example/projects',
      'projects/../user',
      'projects/%252e%252e/user',
      'projects\\..\\user',
      'projects?access_token=x',
      'projects/1/access_tokens',
    ])
      await expect(f.connection.call('gitlab_api_read', { path }, f.signal)).rejects.toThrow();
    await expect(
      f.connection.call(
        'gitlab_api_read',
        { path: 'projects', query: { sudo: 'admin' } },
        f.signal,
      ),
    ).rejects.toThrow('认证信息');
    await expect(
      f.connection.call('gitlab_api_read', { path: 'projects', method: 'DELETE' }, f.signal),
    ).rejects.toThrow();
    await expect(
      f.connection.call('gitlab_api_write', { path: 'projects', method: 'GET' }, f.signal),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('handles redirects, oversized responses and cancellation safely', async () => {
    const f = fixture();
    f.transport.mockRejectedValueOnce(new Error('redirect with ' + token));
    await expect(f.connection.connect(f.signal)).rejects.toThrow('无法连接');
    f.transport.mockResolvedValueOnce(new Response('x'.repeat(2_000_001)));
    await expect(
      f.connection.call('gitlab_api_read', { path: 'projects' }, f.signal),
    ).rejects.toThrow('返回内容过大');
    const signal = AbortSignal.abort();
    f.transport.mockImplementationOnce(async (_url, init) => {
      init?.signal?.throwIfAborted();
      throw new Error();
    });
    await expect(f.connection.connect(signal)).rejects.toThrow();
  });
  it('enforces read-only sessions, denied writes and credential revocation in active scopes', async () => {
    const f = fixture();
    const store = new Store(':memory:', { encrypt: (v) => 'enc:' + v, decrypt: (v) => v.slice(4) });
    cleanup.push(() => store.close());
    store.put('plugin', { ...config, readOnlyTools: ['gitlab_api_write'] });
    store.saveSecret('plugin_' + config.id, secret);
    const approve = vi.fn(async () => false);
    const scope = new ToolScope(f.signal, approve, () => {});
    cleanup.push(() => scope.close());
    await scope.prepare(store, agent);
    const gateway = mcpName(config.id, 'discover');
    const result = await scope.call(gateway, {
      action: 'call',
      tool: 'gitlab_api_write',
      arguments: { path: 'projects/42/issues', method: 'POST', body: { title: 'Fixture' } },
    });
    expect(result.isError).toBe(true);
    expect(approve).toHaveBeenCalledOnce();
    expect(f.requests.some((r) => r.init.method === 'POST')).toBe(false);
    const readOnly = new ToolScope(f.signal, approve, () => {});
    cleanup.push(() => readOnly.close());
    await readOnly.prepare(store, { ...agent, permission: 'read-only' });
    const catalog = await readOnly.call(gateway, { action: 'list' });
    expect(catalog.text).toContain('gitlab_api_read');
    expect(catalog.text).not.toContain('gitlab_api_write');
    store.saveSecret('plugin_' + config.id, JSON.stringify({ Authorization: 'Bearer rotated' }));
    await expect(scope.call(gateway, { action: 'list' })).rejects.toThrow('配置已改变');
  });
  it('verifies GitHub Token identity through the official API and hides invalid token responses', async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(new Response('{"id":7,"login":"fixture-user"}'));
    await verifyGithubPluginToken(secret, f.signal);
    expect(f.requests).toHaveLength(0);
    expect(String(f.transport.mock.calls[0][0])).toBe('https://api.github.com/user');
    f.transport.mockResolvedValueOnce(new Response(token, { status: 401 }));
    await expect(verifyGithubPluginToken(secret, f.signal)).rejects.toThrow('已失效');
    f.transport.mockResolvedValueOnce(new Response(token));
    await expect(verifyGithubPluginToken(secret, f.signal)).rejects.toThrow('身份校验失败');
  });
});
