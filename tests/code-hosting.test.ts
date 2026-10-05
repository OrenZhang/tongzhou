import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import type { AgentProfile, PluginConfig, Project } from '../src/shared/types';
import { codeHost, codeHostHeaders, githubMcpUrl, gitlabMcpUrl } from '../src/shared/code-hosting';
import { pluginSecret, codeHostingContext } from '../electron/code-hosting';
import { PluginConnection, ToolScope, mcpName } from '../electron/extensions';
import { PluginOAuthProvider, pluginOAuthScope } from '../electron/mcp-auth';
import { Store } from '../electron/store';
import { setServiceTransport } from '../electron/service-network';
import { toolBridge } from '../electron/tool-bridge';
import { userAgent } from '../electron/request-identity';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  setServiceTransport();
  vi.restoreAllMocks();
});
const agent: AgentProfile = {
  id: 'a',
  name: 'a',
  description: '',
  instructions: '',
  providerId: '',
  model: '',
  permission: 'ask',
  maxSteps: 16,
};
const config = (id: string, url: string): PluginConfig => ({
  id,
  name: id,
  transport: 'http',
  command: '',
  args: [],
  url,
  enabled: true,
  readOnlyTools: [],
  authMode: 'headers',
});

async function fixture() {
  const store = new Store(':memory:', {
    encrypt: (v) => 'encrypted:' + v,
    decrypt: (v) => v.slice(10),
  });
  cleanup.push(() => store.close());
  const catalog = Array.from({ length: 245 }, (_, i) => ({
    name: `read_item_${i}`,
    description: `Read item ${i}`,
    inputSchema: {
      type: 'object',
      properties: { repository: { type: 'string' } },
      required: ['repository'],
    },
    annotations: { readOnlyHint: true },
  }));
  catalog.push({
    name: 'rerun_failed_jobs',
    description: 'Retry failed CI workflow pipeline jobs',
    inputSchema: {
      type: 'object',
      properties: { repository: { type: 'string' } },
      required: ['repository'],
    },
    annotations: { readOnlyHint: false },
  });
  const requests: {
    url: string;
    method: string;
    authorization?: string;
    body: any;
    headers: any;
  }[] = [];
  let repeatCursor = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const b of req) raw += b;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({
      url: req.url!,
      method: req.method!,
      authorization: req.headers.authorization,
      body,
      headers: req.headers,
    });
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (body.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: any = {};
    if (body.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    if (body.method === 'tools/list') {
      const offset = Number(body.params?.cursor ?? 0);
      result = {
        tools: catalog.slice(offset, offset + 70),
        ...(offset + 70 < catalog.length
          ? { nextCursor: repeatCursor ? '70' : String(offset + 70) }
          : {}),
      };
    }
    if (body.method === 'tools/call')
      result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: body.params.name,
              args: body.params.arguments,
              secret: req.headers.authorization?.slice(7),
            }),
          },
        ],
      };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const local = `http://127.0.0.1:${(server.address() as any).port}`;
  setServiceTransport(async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    return fetch(local + u.pathname, init);
  });
  const github = config('github-fixture', githubMcpUrl);
  const gitlab = { ...config('gitlab-fixture', gitlabMcpUrl), authMode: 'oauth' as const };
  store.put('plugin', github);
  store.put('plugin', gitlab);
  store.saveSecret(
    'plugin_' + github.id,
    JSON.stringify({ Authorization: 'Bearer github-secret-fixture' }),
  );
  new PluginOAuthProvider(store, gitlab).saveTokens({
    access_token: 'gitlab-secret-fixture',
    token_type: 'Bearer',
  });
  const prepare = async (
    permission: AgentProfile['permission'] = 'ask',
    approve = vi.fn(async (_title: string, _detail: string) => true),
  ) => {
    const controller = new AbortController();
    const record = vi.fn();
    const scope = new ToolScope(controller.signal, approve, record);
    cleanup.push(() => scope.close());
    await scope.prepare(store, { ...agent, permission });
    return { scope, controller, approve, record };
  };
  return {
    store,
    requests,
    github,
    gitlab,
    prepare,
    repeat: () => {
      repeatCursor = true;
    },
  };
}

describe('complete code hosting plugin catalogs', () => {
  it('discovers both complete paginated catalogs lazily, searches/describes and calls through the native bridge', async () => {
    const f = await fixture();
    const { scope, controller, approve } = await f.prepare();
    expect(scope.specs).toHaveLength(3);
    expect(f.requests).toHaveLength(0);
    const bridge = await toolBridge(scope, controller.signal);
    cleanup.push(() => bridge.close());
    const call = async (p: PluginConfig, args: any) => {
      const response = await fetch(bridge.config.env[0].value, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + bridge.config.env[1].value },
        body: JSON.stringify({ method: 'call', name: mcpName(p.id, 'discover'), arguments: args }),
      });
      return response.json();
    };
    for (const p of [f.github, f.gitlab]) {
      const first = await call(p, { action: 'list' });
      expect(JSON.parse(first.content[0].text)).toMatchObject({ total: 246, nextOffset: 10 });
      const last = JSON.parse((await call(p, { action: 'list', offset: 240 })).content[0].text);
      expect(last.nextOffset).toBeNull();
      expect(last.tools).toHaveLength(6);
      const search = JSON.parse(
        (await call(p, { action: 'list', query: 'failed jobs' })).content[0].text,
      );
      expect(search.tools.map((t: any) => t.name)).toEqual(['rerun_failed_jobs']);
      const schema = JSON.parse(
        (await call(p, { action: 'describe', tool: 'rerun_failed_jobs' })).content[0].text,
      );
      expect(schema.inputSchema.required).toEqual(['repository']);
      const result = await call(p, {
        action: 'call',
        tool: 'rerun_failed_jobs',
        arguments: { repository: 'group/project' },
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('REDACTED');
      expect(result.content[0].text).not.toContain('secret-fixture');
    }
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve.mock.calls[0][0]).toContain('rerun_failed_jobs');
    const lists = f.requests.filter((r) => r.body.method === 'tools/list');
    expect(lists).toHaveLength(8);
    expect(lists.find((r) => r.url === '/mcp/')?.headers['x-mcp-toolsets']).toBe('all');
    expect(
      lists.find((r) => r.url === '/api/v4/mcp')?.headers['x-gitlab-enabled-mcp-server-toolsets'],
    ).toBe('all');
    expect(lists.every((r) => r.headers['user-agent'] === userAgent)).toBe(true);
    expect(lists.find((r) => r.url === '/api/v4/mcp')?.authorization).toBe(
      'Bearer gitlab-secret-fixture',
    );
    expect(JSON.stringify(f.store.list('plugin'))).not.toContain('secret-fixture');
    // Persisted catalogs never expand the next model request into hundreds of functions.
    expect((await f.prepare()).scope.specs).toHaveLength(3);
  });

  it('filters read-only catalogs and blocks guessed writes, denials, logout and changes during approval', async () => {
    const f = await fixture();
    const { scope, approve } = await f.prepare('read-only');
    const name = mcpName(f.github.id, 'discover');
    expect(JSON.parse((await scope.call(name, { action: 'list' })).text).total).toBe(245);
    expect((await scope.call(name, { action: 'call', tool: 'rerun_failed_jobs' })).isError).toBe(
      true,
    );
    expect(approve).not.toHaveBeenCalled();
    expect(f.requests.some((r) => r.body.method === 'tools/call')).toBe(false);
    const denied = await f.prepare(
      'ask',
      vi.fn(async () => false),
    );
    expect(
      (await denied.scope.call(name, { action: 'call', tool: 'rerun_failed_jobs' })).text,
    ).toContain('未批准');
    const changed = await f.prepare(
      'ask',
      vi.fn(async () => {
        f.store.put('plugin', { ...f.github, enabled: false });
        return true;
      }),
    );
    expect(
      (await changed.scope.call(name, { action: 'call', tool: 'rerun_failed_jobs' })).isError,
    ).toBe(true);
    expect(f.requests.some((r) => r.body.method === 'tools/call')).toBe(false);
    const gitlabName = mcpName(f.gitlab.id, 'discover');
    await scope.call(gitlabName, { action: 'list' });
    f.store.put('mcpAuthEpoch', { id: f.gitlab.id, value: 'logged-out' });
    await expect(scope.call(gitlabName, { action: 'call', tool: 'read_item_1' })).rejects.toThrow(
      '配置已改变',
    );
  });

  it('uses refreshed bound credentials in new runs and revokes old scopes and disabled accounts', async () => {
    const f = await fixture();
    const account = { id: 'account', kind: 'github', enabled: true, baseUrl: 'https://github.com' };
    f.store.put('connector', account);
    const bound = { ...f.github, connectorId: account.id };
    f.store.put('plugin', bound);
    f.store.saveSecret('connector_account', 'old-account-token');
    const old = await f.prepare();
    f.store.saveSecret('connector_account', 'new-account-token');
    await expect(old.scope.call(mcpName(bound.id, 'discover'), { action: 'list' })).rejects.toThrow(
      '配置已改变',
    );
    const fresh = await f.prepare();
    await fresh.scope.call(mcpName(bound.id, 'discover'), { action: 'list' });
    expect(
      f.requests
        .filter((r) => r.url === '/mcp/')
        .every((r) => r.authorization === 'Bearer new-account-token'),
    ).toBe(true);
    f.store.put('connector', { ...account, enabled: false });
    expect(() => pluginSecret(f.store, bound)).toThrow('停用');
    expect(() => pluginSecret(f.store, { ...bound, url: 'https://evil.example/mcp' })).toThrow(
      '不匹配',
    );
  });

  it('rejects malformed pagination and looping upstream cursors without sending a tool call', async () => {
    const f = await fixture();
    const { scope } = await f.prepare();
    expect(
      (await scope.call(mcpName(f.github.id, 'discover'), { action: 'list', offset: -1 })).isError,
    ).toBe(true);
    f.repeat();
    const connection = new PluginConnection(f.gitlab, '');
    cleanup.push(() => connection.close());
    await connection.connect(AbortSignal.timeout(3000));
    await expect(connection.tools(AbortSignal.timeout(3000))).rejects.toThrow(/重复/);
    expect(f.requests.some((r) => r.body.method === 'tools/call')).toBe(false);
  });
});

it('recognizes only supported endpoints and configures GitLab OAuth mcp scope including self-managed instances', () => {
  for (const url of [
    gitlabMcpUrl,
    'https://git.example.com/api/v4/mcp',
    'https://git.example.com/gitlab/api/v4/mcp',
  ]) {
    const p = config('p', url);
    expect(codeHost(p)).toBe('gitlab');
    expect(pluginOAuthScope(p)).toBe('mcp');
    expect(codeHostHeaders(p).get('X-Gitlab-Enabled-Mcp-Server-Toolsets')).toBe('all');
  }
  for (const url of [
    'https://api.githubcopilot.com.evil.example/mcp/',
    'https://gitlab.com/not-mcp',
    'http://gitlab.com/api/v4/mcp',
    'https://user:pass@gitlab.com/api/v4/mcp',
  ])
    expect(codeHost(config('p', url))).toBeUndefined();
});

it('provides repository and account context with URL credentials and query strings removed', async () => {
  const f = await fixture();
  const exec = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-code-host-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', root]);
  await exec(
    'git',
    [
      'remote',
      'add',
      'origin',
      'https://user:secret@gitlab.example/group/subgroup/project.git?token=private',
    ],
    { cwd: root },
  );
  const project = {
    id: 'project',
    name: 'Project',
    path: root,
    gitConnectorId: 'account',
  } as Project;
  const result = await codeHostingContext(f.store, project, new AbortController().signal);
  expect(result.project).toMatchObject({
    host: 'gitlab.example',
    repository: 'group/subgroup/project',
    connectorId: 'account',
  });
  expect(JSON.stringify(result)).not.toMatch(/secret|private/);
});
