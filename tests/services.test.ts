import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { Channels, webhookUrl } from '../electron/channels';
import { Connectors } from '../electron/connectors';
import { initializeAgent } from '../electron/project-init';
import { executeTool, fileHash, commandResult } from '../electron/workspace';
import { ToolScope } from '../electron/extensions';
import { ClientCommands, operation } from '../electron/client-commands';
import { z } from 'zod';
import { Feishu } from '../electron/feishu';
import { Runtime } from '../electron/runtime';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function store() {
  const s = new Store(':memory:', {
    encrypt: (v) => Buffer.from(v).toString('base64'),
    decrypt: (v) => Buffer.from(v, 'base64').toString(),
  });
  cleanups.push(() => s.close());
  return s;
}
async function root() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-services-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-secret';
describe('connection and channel services', () => {
  it('keeps webhook and signing credentials out of snapshots', () => {
    const s = store();
    const c = new Channels(s, () => {});
    c.save({
      id: 'f',
      name: '飞书',
      kind: 'feishu',
      enabled: true,
      webhook,
      signingSecret: 'secret-sign',
    });
    expect(JSON.stringify(c.list())).not.toContain('secret');
    expect(s.secret('channel_url_f')).toBe(webhook);
    expect(() => webhookUrl('wecom', webhook)).toThrow('官方');
    expect(() =>
      webhookUrl('feishu', 'https://open.feishu.cn.attacker.test/open-apis/bot/v2/hook/key'),
    ).toThrow();
  });
  it('deduplicates hooks and consumes one-shot rules before dispatch', async () => {
    const s = store(),
      session = s.createSession();
    const transport = vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    const c = new Channels(s, () => {}, transport as any);
    c.save({ id: 'f', name: '飞书', kind: 'feishu', enabled: true, webhook });
    c.saveRule({
      id: 'r',
      channelId: 'f',
      sessionId: session.id,
      enabled: true,
      once: true,
      events: ['completed'],
      template: '{title} {status}',
    });
    const run: any = { id: 'run', sessionId: session.id, model: 'mock' };
    await Promise.all([c.notify(run, 'completed'), c.notify(run, 'completed')]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(s.list<any>('delivery')[0].status).toBe('sent');
    expect(s.get<any>('notificationRule', 'r').enabled).toBe(false);
  });
  it('records an uncertain send without retries and treats platform errors as failures', async () => {
    const s = store();
    let calls = 0;
    const transport = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('timeout including private URL');
      return new Response(JSON.stringify({ code: 19024, msg: 'contains secret' }));
    });
    const c = new Channels(s, () => {}, transport as any);
    c.save({ id: 'f', name: '飞书', kind: 'feishu', enabled: true, webhook });
    expect((await c.send('f', 'test', undefined, 'same')).status).toBe('unknown');
    await c.send('f', 'test', undefined, 'same');
    expect(calls).toBe(1);
    expect((await c.send('f', 'test', undefined, 'new')).status).toBe('failed');
    expect(JSON.stringify(s.list('delivery'))).not.toContain('private URL');
    c.save({ id: 'f', name: '飞书', kind: 'feishu', enabled: false });
    await expect(c.send('f', 'test')).rejects.toThrow('停用');
  });
  it('validates identities per connector and does not send tokens through redirects', async () => {
    const s = store(),
      c = new Connectors(s, () => {});
    cleanups.push(() => c.dispose());
    c.save({
      id: 'g1',
      kind: 'github',
      name: 'GitHub A',
      baseUrl: 'https://github.com',
      enabled: true,
      secret: 'fixture-token',
    });
    c.save({
      id: 'g2',
      kind: 'gitlab',
      name: 'GitLab B',
      baseUrl: 'https://gitlab.com',
      enabled: true,
      secret: 'other-token',
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 12, login: 'fixture-user' })));
    expect(await c.test('g1')).toContain('fixture-user');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
    });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe(
      'Bearer fixture-token',
    );
    expect(c.list().find((x) => x.id === 'g2')?.status).toBe('configured');
    expect(JSON.stringify(c.list())).not.toContain('fixture-token');
    fetch.mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(c.test('g2')).rejects.toThrow('401');
    expect(c.list().find((x) => x.id === 'g1')?.account).toBe('fixture-user');
  });
  it('accepts only bound human Feishu senders and deduplicates remote messages', async () => {
    const s = store(),
      session = s.createSession();
    s.put('session', { ...session, model: 'model' });
    s.put('channel', {
      id: 'f',
      name: 'f',
      kind: 'feishu',
      mode: 'app',
      enabled: true,
      inbound: true,
      sessionId: session.id,
      receiveIdType: 'open_id',
      allowedSenders: ['user1'],
    });
    const enqueue = vi.fn(async () => {});
    const service = new Feishu(s, { enqueue } as unknown as Runtime);
    cleanups.push(() => service.dispose());
    const event = {
      sender: { sender_type: 'user', sender_id: { open_id: 'user1' } },
      message: {
        message_id: 'msg1',
        message_type: 'text',
        chat_type: 'p2p',
        content: JSON.stringify({ text: 'Continue' }),
      },
    };
    await service.receive('f', {
      ...event,
      sender: { sender_type: 'app', sender_id: { open_id: 'user1' } },
    });
    await service.receive('f', {
      ...event,
      sender: { sender_type: 'user', sender_id: { open_id: 'outsider' } },
    });
    expect(enqueue).not.toHaveBeenCalled();
    await service.receive('f', event);
    await service.receive('f', event);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]).toMatchObject([
      { sessionId: session.id, prompt: expect.stringContaining('Continue') },
      'supplement',
    ]);
  });
});
describe('project initialization and controlled edits', () => {
  it('respects gitignore and returns structured command evidence with Unicode output', async () => {
    const dir = await root();
    await writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(dir, 'ignored.txt'), 'needle private fixture');
    await writeFile(path.join(dir, 'visible.txt'), 'needle public fixture');
    const result = JSON.parse(
      await executeTool(
        'search_files',
        '{"query":"needle"}',
        dir,
        'read-only',
        new AbortController().signal,
        async () => false,
      ),
    );
    expect(result.matches.map((m: any) => m.path)).toEqual(['visible.txt']);
    const command = await commandResult(
      process.execPath,
      [
        '-e',
        'process.stdout.write("中文"); process.stderr.write("diagnostic"); process.exitCode=3',
      ],
      dir,
      new AbortController().signal,
    );
    expect(command).toMatchObject({
      exitCode: 3,
      status: 'completed',
      stdout: '中文',
      stderr: 'diagnostic',
    });
    expect(command.commandId).toBeTruthy();
  });
  it('generates actual commands and preserves existing instructions', async () => {
    const dir = await root();
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }),
    );
    expect((await initializeAgent(dir)).created).toBe(true);
    expect(await readFile(path.join(dir, 'agent.md'), 'utf8')).toContain('npm run test');
    await writeFile(path.join(dir, 'agent.md'), 'Handwritten instructions');
    expect((await initializeAgent(dir)).created).toBe(false);
    expect(await readFile(path.join(dir, 'agent.md'), 'utf8')).toBe('Handwritten instructions');
  });
  it('rejects stale edits and changes made while approval was pending', async () => {
    const dir = await root();
    await writeFile(path.join(dir, 'code.ts'), 'return old;');
    const args = {
      path: 'code.ts',
      expectedHash: fileHash('return old;'),
      oldText: 'old',
      newText: 'fixed',
    };
    await expect(
      executeTool(
        'apply_edit',
        JSON.stringify(args),
        dir,
        'ask',
        new AbortController().signal,
        async () => {
          await writeFile(path.join(dir, 'code.ts'), 'User changes');
          return true;
        },
      ),
    ).rejects.toThrow('审批期间');
    await expect(
      executeTool(
        'apply_edit',
        JSON.stringify(args),
        dir,
        'ask',
        new AbortController().signal,
        async () => true,
      ),
    ).rejects.toThrow('文件已变化');
    expect(await readFile(path.join(dir, 'code.ts'), 'utf8')).toBe('User changes');
  });
  it('does not start an unused MCP, and rejects a revoked tool', async () => {
    const s = store();
    s.put('plugin', {
      id: 'p',
      name: 'offline',
      command: 'not-a-real-program',
      args: [],
      url: '',
      enabled: true,
      transport: 'stdio',
      readOnlyTools: [],
    });
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanups.push(() => scope.close());
    await scope.prepare(s, {
      id: '',
      name: '',
      description: '',
      instructions: '',
      providerId: '',
      model: '',
      permission: 'ask',
      maxSteps: 10,
    });
    expect(scope.specs).toHaveLength(1);
    s.put('plugin', { ...s.get<any>('plugin', 'p'), enabled: false });
    await expect(scope.call(scope.specs[0].name, { action: 'list' })).rejects.toThrow('停用');
  });
  it('allows non-secret provider settings and rejects secret fields in chat management', async () => {
    const commands = new ClientCommands(),
      handler = vi.fn(async () => ({}));
    commands.register(
      'saveProvider',
      operation('模型', 'change', '保存连接', [
        z.object({ maxOutputTokens: z.number().optional() }),
      ]),
      handler,
    );
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanups.push(() => scope.close());
    commands.attach(scope, false, () => true, 's');
    await scope.call(
      'client_change',
      { method: 'saveProvider', args: [{ maxOutputTokens: 1000 }] },
      '1',
    );
    expect(handler).toHaveBeenCalledOnce();
    const result = await scope.call(
      'client_change',
      { method: 'saveProvider', args: [{ secret: 'private' }] },
      '2',
    );
    expect(result.isError).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});
