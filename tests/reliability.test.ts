import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../electron/store';
import { Runtime } from '../electron/runtime';
import { portableHistory } from '../electron/providers';
import { executeTool, fileHash } from '../electron/workspace';
import { Connectors } from '../electron/connectors';
import { gitlabLogin, gitlabRedirect } from '../electron/oauth-pkce';
import type { Message } from '../src/shared/types';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function store() {
  const s = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanups.push(() => s.close());
  return s;
}
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-reliability-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe('long conversations and concurrent changes', () => {
  it('returns Unicode shell output and preserves explicit command failure codes', async () => {
    const root = await directory();
    const run = (command: string) =>
      executeTool(
        'run_command',
        JSON.stringify({ command }),
        root,
        'ask',
        new AbortController().signal,
        async () => true,
      );
    const script =
      process.platform === 'win32'
        ? "Write-Output '同舟：中文与引号 ''完整'''; exit 7"
        : "printf '%s\\n' '同舟：中文与引号 完整'; exit 7";
    const result = JSON.parse(await run(script));
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain('同舟：中文与引号');
    expect(result.stdout).not.toContain('\ufffd');
  });
  it.skipIf(process.platform !== 'win32')(
    'reports PowerShell parsing failures in readable UTF-8',
    async () => {
      const result = JSON.parse(
        await executeTool(
          'run_command',
          JSON.stringify({ command: "Write-Output '中文' && Write-Output '第二条'" }),
          await directory(),
          'ask',
          new AbortController().signal,
          async () => true,
        ),
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('&&');
      expect(result.stderr).not.toContain('\ufffd');
    },
  );
  it('preflights multi-file edits before approval and reports a partial commit after a later conflict', async () => {
    const root = await directory();
    for (const file of ['a.txt', 'b.txt']) await writeFile(path.join(root, file), 'before');
    const edits = ['a.txt', 'b.txt'].map((file) => ({
      path: file,
      expectedHash: fileHash('before'),
      oldText: 'before',
      newText: 'after',
    }));
    const approval = vi.fn(async () => true);
    await expect(
      executeTool(
        'apply_edits',
        JSON.stringify({ edits: [edits[0], { ...edits[1], oldText: 'wrong' }] }),
        root,
        'ask',
        new AbortController().signal,
        approval,
      ),
    ).rejects.toThrow('整批未执行');
    expect(approval).not.toHaveBeenCalled();
    await expect(
      executeTool(
        'apply_edits',
        JSON.stringify({ edits }),
        root,
        'ask',
        new AbortController().signal,
        async () => {
          await writeFile(path.join(root, 'b.txt'), 'user edit');
          return true;
        },
      ),
    ).rejects.toThrow('已应用：a.txt');
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('after');
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('user edit');
  });
  it('retains sourced historical goals without promoting tools or dropping the current turn', () => {
    const messages: Message[] = Array.from({ length: 40 }, (_, i) => ({
      id: 'm' + i,
      sessionId: 's',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content:
        (i === 0 ? 'Preserve original constraint. ' : 'Record ' + i + '. ') + 'x'.repeat(300),
      createdAt: i,
    }));
    let summary: Message | undefined;
    const result = portableHistory(messages, 5000, (m) => {
      summary = m;
    });
    expect(summary?.content).toContain('Preserve original constraint');
    expect(summary?.role).toBe('assistant');
    expect(result.at(-1)?.id).toBe('m39');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(5000);
    expect(messages[0].content).toContain('Preserve original constraint');
  });
  it('paginates by immutable sequence without duplicate messages after streamed updates', () => {
    const s = store(),
      session = s.createSession();
    for (let i = 0; i < 240; i++)
      s.message({
        id: 'message-' + i,
        sessionId: session.id,
        role: 'user',
        content: String(i),
        createdAt: i,
      });
    const recent = s.messagesPage(session.id);
    s.message({ ...recent[0], content: 'updated' });
    const older = s.messagesPage(session.id, recent[0].id);
    expect(recent).toHaveLength(100);
    expect(older).toHaveLength(100);
    expect(older.at(-1)?.content).toBe('139');
    expect(s.messagesPage(session.id, older[0].id)).toHaveLength(40);
    expect(() => s.messagesPage(session.id, 'foreign-message')).toThrow();
  });
  it('serializes concurrent edits and rejects a second writer holding a stale hash', async () => {
    const root = await directory();
    await writeFile(path.join(root, 'source.txt'), 'before');
    const hash = fileHash('before');
    const results = await Promise.allSettled(
      ['one', 'two'].map((content) =>
        executeTool(
          'write_file',
          JSON.stringify({ path: 'source.txt', content, expectedHash: hash }),
          root,
          'ask',
          new AbortController().signal,
          async () => true,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('one');
  });
  it('removes internal child data and disables inbound bindings while preserving project files', async () => {
    const s = store(),
      root = await directory(),
      runtime = new Runtime(s, root, () => {});
    cleanups.push(() => runtime.stop());
    const parent = s.createSession(),
      child = s.createSession(null, parent.id),
      grandchild = s.createSession(null, child.id);
    const branch = s.createSession();
    for (const session of [parent, child, grandchild]) {
      await mkdir(path.join(root, 'chat-workspaces', session.id), { recursive: true });
      await writeFile(path.join(root, 'chat-workspaces', session.id, 'temp'), 'owned');
    }
    await writeFile(path.join(root, 'user-project.txt'), 'preserve');
    s.put('channel', { id: 'bound', sessionId: grandchild.id, inbound: true, enabled: true });
    await runtime.deleteSession(parent.id);
    expect(s.list<any>('session').map((v) => v.id)).toEqual([branch.id]);
    expect(s.get<any>('channel', 'bound').inbound).toBe(false);
    await expect(access(path.join(root, 'chat-workspaces', grandchild.id))).rejects.toThrow();
    expect(await readFile(path.join(root, 'user-project.txt'), 'utf8')).toBe('preserve');
  });
});
describe('OAuth and connector lifecycle', () => {
  it('never carries a token to a different service origin', () => {
    const s = store(),
      c = new Connectors(s, () => {});
    c.save({
      id: 'git',
      name: 'Git',
      kind: 'gitlab',
      enabled: true,
      baseUrl: 'https://gitlab.com',
      secret: 'original-token',
    });
    c.save({
      id: 'git',
      name: 'Git',
      kind: 'gitlab',
      enabled: true,
      baseUrl: 'https://git.example.com',
    });
    expect(s.secret('connector_git')).toBe('');
  });
  it('refreshes GitLab authorization after an expired access token and keeps credentials private', async () => {
    const s = store(),
      c = new Connectors(s, () => {});
    c.save({
      id: 'git',
      name: 'Git',
      kind: 'gitlab',
      enabled: true,
      baseUrl: 'https://gitlab.com',
      clientId: 'public',
      secret: 'expired',
    });
    s.saveSecret('connector_refresh_git', 'refresh-one');
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'refresh-two' })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 7, username: 'fixture' })));
    await c.test('git');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(s.secret('connector_refresh_git')).toBe('refresh-two');
    expect(JSON.stringify(c.list())).not.toContain('new-access');
    expect(c.list()[0].status).toBe('connected');
  });
  it('validates OAuth state, exchanges a PKCE verifier and flushes the browser success response', async () => {
    const original = globalThis.fetch,
      controller = new AbortController();
    cleanups.push(() => controller.abort());
    const accept = vi.fn(async () => {}),
      failure = vi.fn(),
      finished = vi.fn();
    const login = await gitlabLogin(
      'https://gitlab.example.com',
      'public-client',
      controller.signal,
      accept,
      failure,
      finished,
    );
    const url = new URL(login.url),
      state = url.searchParams.get('state')!;
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await original(gitlabRedirect + '?state=wrong&code=x')).status).toBe(400);
    let posted: URLSearchParams | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'https://gitlab.example.com/oauth/token') {
        posted = init?.body as URLSearchParams;
        return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }));
      }
      return original(input, init);
    });
    const response = await original(gitlabRedirect + '?state=' + state + '&code=fixture');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('授权已验证');
    expect(posted?.get('code_verifier')?.length).toBeGreaterThan(32);
    expect(accept).toHaveBeenCalledWith('access', 'refresh', undefined);
    expect(failure).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalled();
  });
});
