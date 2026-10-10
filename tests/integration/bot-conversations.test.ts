import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Store } from '../../electron/services/storage/store';
import { Bots } from '../../electron/services/channels/bots';
import { botClientPolicy } from '../../electron/services/bots/client-policy';
import { botPermission } from '../../electron/services/bots/access';
import { ClientCommands, operation } from '../../electron/core/tools/client-commands';
import { ToolScope } from '../../electron/core/tools/extensions';
import type { BotConfig, Run, RunInput, Session } from '../../src/shared/types';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanup.push(() => store.close());
  store.put('provider', { id: 'provider', name: 'Fixture', models: ['model'], enabled: true });
  let seq = 0;
  const runtime = {
    changed: vi.fn(),
    start: vi.fn((input: RunInput) => {
      const run = {
        id: `run-${++seq}`,
        sessionId: input.sessionId,
        botContext: input.botContext,
        status: 'running',
        startedAt: Date.now(),
      } as Run;
      store.put('run', run);
      return run.id;
    }),
    isActive: vi.fn(() => false),
    enqueue: vi.fn(),
    cancel: vi.fn(),
    snapshot: vi.fn(() => ({ approvals: [] }) as any),
  };
  const bots = new Bots(store, runtime, (() => ({ close() {} })) as any);
  cleanup.push(() => bots.dispose());
  const config: BotConfig = {
    id: 'bot',
    name: '微信',
    kind: 'weixin',
    appId: 'app',
    allowedSenders: ['alice', 'bob'],
    allowedChats: ['group'],
  };
  bots.save({ ...config, secret: 'token' });
  const reply = vi.fn(async (_text: string) => {});
  const message = {
    id: 'first',
    sender: 'alice',
    chat: 'alice',
    group: false,
    text: '你好呀',
    reply,
  };
  return { store, bots, config, runtime, message, reply };
}
it('starts an independent conversation with zero or many local sessions and continues without a session ID', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) f.store.createSession();
  expect(await f.bots.receive('bot', f.message)).toBeUndefined();
  const first = f.runtime.start.mock.calls[0][0];
  expect(first.prompt).toBe('你好呀');
  expect(first.model).toBe('model');
  expect(f.store.get<Session>('session', first.sessionId).botConversation).toMatchObject({
    sender: 'alice',
    botId: 'bot',
  });
  await f.bots.receive('bot', { ...f.message, id: 'second', text: '继续刚才的话题' });
  expect(f.runtime.start.mock.calls[1][0].sessionId).toBe(first.sessionId);
  await f.bots.receive('bot', { ...f.message, id: 'second' });
  expect(f.runtime.start).toHaveBeenCalledTimes(2);
});
it('isolates sender and group history, while all platforms share model settings', async () => {
  const f = fixture();
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'full-access',
    mode: 'workbench',
  });
  f.bots.save({ ...f.config, id: 'feishu', kind: 'feishu', secret: 'token' });
  await f.bots.receive('bot', f.message);
  await f.bots.receive('bot', { ...f.message, id: 'bob', sender: 'bob', chat: 'bob' });
  await f.bots.receive('bot', { ...f.message, id: 'group', chat: 'group', group: true });
  await f.bots.receive('feishu', f.message);
  const inputs = f.runtime.start.mock.calls.map(([input]) => input);
  expect(new Set(inputs.map((i) => i.sessionId)).size).toBe(4);
  for (const input of inputs)
    expect(input).toMatchObject({ providerId: 'provider', model: 'model' });
});
it('does not create empty chats on missing model or unauthorized senders', async () => {
  const f = fixture();
  await f.bots.receive('bot', { ...f.message, sender: 'outsider' });
  expect(f.runtime.start).not.toHaveBeenCalled();
  f.store.remove('provider', 'provider');
  expect(await f.bots.receive('bot', f.message)).toContain('通用设置');
  expect(f.store.list('session')).toHaveLength(0);
});
it('allows readonly conversational answers without enabling mutations', async () => {
  const f = fixture();
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'read-only',
    mode: 'workbench',
  });
  await f.bots.receive('bot', f.message);
  const input = f.runtime.start.mock.calls[0][0];
  expect(f.store.get<Session>('session', input.sessionId).permission).toBe('read-only');
  expect(botPermission(f.store, input.botContext!, 'full-access')).toBe('read-only');
  f.store.message({
    id: 'answer',
    sessionId: input.sessionId,
    runId: 'run-1',
    role: 'assistant',
    content: '你好，我是同舟。',
    createdAt: 1,
    status: 'complete',
  });
  await f.bots.notify(f.store.get('run', 'run-1'), 'completed');
  expect(f.reply).toHaveBeenCalledExactlyOnceWith('你好，我是同舟。');
});
it('controls all regular sessions but isolates other bot conversations and forbids self-escalation', async () => {
  const f = fixture();
  const visible = f.store.createSession(),
    hidden = f.store.createSession();
  f.store.put('session', {
    ...hidden,
    botConversation: { botId: 'other', sender: 'other', chat: 'other', group: false },
  });
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'ask',
    mode: 'workbench',
  });
  await f.bots.receive('bot', f.message);
  const input = f.runtime.start.mock.calls[0][0];
  const policy = botClientPolicy(f.store, input.botContext!, 'run-1', f.runtime.start);
  const commands = new ClientCommands();
  commands.register('snapshot', operation('客户端', 'query', '状态'), () => ({
    sessions: f.store.list('session'),
    runs: [],
  }));
  const read = vi.fn(() => ['history']);
  commands.register('messages', operation('会话', 'query', '历史', [z.string()]), read);
  const save = vi.fn();
  commands.register('saveBot', operation('机器人', 'change', '配置', [z.any()]), save);
  commands.register('contentWrite', operation('内容', 'change', '保存', [z.any()]), save);
  const scope = new ToolScope(
    new AbortController().signal,
    async () => true,
    () => {},
  );
  cleanup.push(() => scope.close());
  commands.attach(scope, false, () => true, input.sessionId, policy);
  const snapshot = JSON.parse((await scope.call('client_query', { method: 'snapshot' })).text!);
  expect(snapshot.sessions.map((s: Session) => s.id)).toEqual(
    expect.arrayContaining([visible.id, input.sessionId]),
  );
  expect(JSON.stringify(snapshot)).not.toContain(hidden.id);
  expect(
    (await scope.call('client_query', { method: 'messages', args: [hidden.id] })).isError,
  ).toBe(true);
  expect(read).not.toHaveBeenCalled();
  await scope.call('client_query', { method: 'messages', args: [visible.id] });
  expect(read).toHaveBeenCalledOnce();
  const catalog = JSON.parse((await scope.call('client_catalog', { method: 'saveBot' })).text!);
  expect(catalog.methods[0].available).toBe(false);
  expect((await scope.call('client_change', { method: 'saveBot', args: [{}] })).isError).toBe(true);
  expect(save).not.toHaveBeenCalled();
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'ask',
    mode: 'workbench',
  });
  expect(policy.unavailable('contentWrite')).toBeUndefined();
  f.bots.remove(f.config.id);
  expect((await scope.call('client_query', { method: 'snapshot' })).isError).toBe(true);
});
it('returns the exact delegated session result after the router completes, only once', async () => {
  const f = fixture();
  const target = f.store.createSession();
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'ask',
    mode: 'workbench',
  });
  await f.bots.receive('bot', f.message);
  const input = f.runtime.start.mock.calls[0][0];
  const policy = botClientPolicy(f.store, input.botContext!, 'run-1', f.runtime.start);
  const result: any = await policy.invoke(
    'run',
    [{ ...input, sessionId: target.id, prompt: '整理文章' }],
    () => {
      throw new Error('must use scoped start');
    },
  );
  expect(result.status).toBe('running');
  const child = f.store.get<Run>('run', result.runId);
  expect(child.botContext?.rootRunId).toBe('run-1');
  await f.bots.notify(f.store.get('run', 'run-1'), 'completed');
  f.store.message({
    id: 'delegated-answer',
    sessionId: target.id,
    runId: child.id,
    role: 'assistant',
    content: '文章已整理完成',
    status: 'complete',
    createdAt: 1,
  });
  f.store.message({
    id: 'unrelated-answer',
    sessionId: target.id,
    runId: 'other',
    role: 'assistant',
    content: '不应转发',
    status: 'complete',
    createdAt: 2,
  });
  await f.bots.notify(child, 'completed');
  expect(f.reply.mock.calls.at(-1)![0]).toContain('文章已整理完成');
  expect(f.reply.mock.calls.at(-1)![0]).not.toContain('不应转发');
  await f.bots.notify(child, 'completed');
  expect(f.reply).toHaveBeenCalledTimes(2);
});
it('rechecks reduced scope before returning delegated results', async () => {
  const f = fixture();
  const target = f.store.createSession();
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'ask',
    mode: 'workbench',
  });
  await f.bots.receive('bot', f.message);
  const input = f.runtime.start.mock.calls[0][0];
  const policy = botClientPolicy(f.store, input.botContext!, 'run-1', f.runtime.start);
  const result: any = await policy.invoke('run', [{ ...input, sessionId: target.id }], () => {});
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'ask',
    mode: 'chat',
  });
  await f.bots.notify(f.store.get('run', result.runId), 'completed');
  expect(f.reply).not.toHaveBeenCalled();
  expect(f.runtime.cancel).toHaveBeenCalledWith(target.id);
});

it('uses connection results without an enable switch and shares default project across bots', async () => {
  const f = fixture();
  const project = f.store.put('project', {
    id: 'bot-project',
    name: 'Project',
    path: process.cwd(),
  });
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'ask',
    mode: 'workbench',
    defaultProjectId: project.id,
  });
  f.bots.save({
    ...f.config,
    id: 'second',
    kind: 'dingtalk',
    secret: 'secret',
    enabled: false,
    allowExecute: false,
    defaultProjectId: 'obsolete',
  });
  await f.bots.receive('second', f.message);
  const input = f.runtime.start.mock.calls[0][0];
  expect(f.store.get<Session>('session', input.sessionId).projectId).toBe(project.id);
  expect(f.bots.list().find((b) => b.id === 'second')).not.toHaveProperty('enabled');
  expect(f.bots.list().find((b) => b.id === 'second')).not.toHaveProperty('defaultProjectId');
});

it('chat mode excludes all workbench commands even if full-access was previously selected', async () => {
  const f = fixture();
  f.store.createSession();
  f.bots.saveSettings({
    providerId: 'provider',
    model: 'model',
    permission: 'full-access',
    mode: 'chat',
  });
  await f.bots.receive('bot', { ...f.message, text: '/sessions' });
  const input = f.runtime.start.mock.calls[0][0];
  expect(f.store.get<Session>('session', input.sessionId).permission).toBe('read-only');
  expect(botPermission(f.store, input.botContext!, 'full-access')).toBe('read-only');
  const policy = botClientPolicy(f.store, input.botContext!, 'run-1', f.runtime.start);
  expect(policy.unavailable('messages')).toContain('仅聊天');
  await expect(policy.invoke('createSession', [], () => f.store.createSession())).rejects.toThrow(
    '仅聊天',
  );
});
it('uses typing instead of an extra acknowledgement and clears it on completion or disconnect', async () => {
  const f = fixture();
  const typing = vi.fn(async (_active: boolean) => {});
  expect(await f.bots.receive('bot', { ...f.message, typing })).toBeUndefined();
  expect(typing).toHaveBeenCalledExactlyOnceWith(true);
  await f.bots.notify(f.store.get('run', 'run-1'), 'completed');
  await f.bots.notify(f.store.get('run', 'run-1'), 'completed');
  expect(typing.mock.calls.map(([v]) => v)).toEqual([true, false]);
  expect(f.reply).toHaveBeenCalledOnce();
  await f.bots.receive('bot', { ...f.message, id: 'second', typing });
  f.bots.restart('bot');
  expect(typing.mock.calls.map(([v]) => v)).toEqual([true, false, true, false]);
});
