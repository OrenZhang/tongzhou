import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../electron/services/storage/store';
import { Runtime } from '../../electron/core/runtime/runtime';
import { Attachments } from '../../electron/modules/artifacts/attachments';
import type { Message, Run, RunEvent } from '../../src/shared/types';

const fake = vi.hoisted(() => ({
  calls: [] as any[],
  instances: [] as any[],
  hold: false,
  loseSteer: false,
  next: 0,
  replies: [] as any[],
}));
vi.mock('../../electron/core/codex/codex', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    CodexClient: class extends EventEmitter {
      constructor(
        public home: string,
        public network?: any,
        _resolveNetwork?: any,
        public modelTransport?: any,
      ) {
        super();
        fake.instances.push(this);
      }
      async start() {}
      stopped = false;
      stop() {
        this.stopped = true;
        this.modelTransport?.close();
      }
      reply(id: string, result: any) {
        fake.replies.push({ id, result });
      }
      reject() {}
      complete(threadId: string, turnId: string) {
        const turns = fake.calls.filter(
          (c) => c.method === 'turn/start' && c.params.threadId === threadId,
        ).length;
        this.emit('notification', {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId,
            tokenUsage: { total: { inputTokens: turns * 100, outputTokens: turns * 10 } },
          },
        });
        this.emit('notification', {
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: { id: 'reply-' + turnId, type: 'agentMessage', text: 'Verified reply' },
          },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        });
      }
      async request(method: string, params: any) {
        fake.calls.push({ method, params });
        if (method === 'model/list')
          return {
            data: [
              {
                model: 'fixture-model',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'none' },
                  { reasoningEffort: 'medium' },
                ],
              },
            ],
          };
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'thread-' + ++fake.next } };
        if (method === 'thread/resume') return { thread: { id: params.threadId } };
        if (method === 'turn/steer' && fake.loseSteer)
          throw new Error('connection lost before acknowledgement');
        if (method === 'turn/start') {
          const id = 'turn-' + ++fake.next;
          this.emit('notification', {
            method: 'turn/started',
            params: { threadId: params.threadId, turn: { id } },
          });
          if (!fake.hold) this.complete(params.threadId, id);
          return { turn: { id } };
        }
        return {};
      }
    },
  };
});
const cleanup: (() => unknown | Promise<unknown>)[] = [];
beforeEach(() => {
  fake.calls = [];
  fake.instances = [];
  fake.hold = false;
  fake.loseSteer = false;
  fake.next = 0;
  fake.replies = [];
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-codex-runtime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  store.saveProvider({ ...store.providers().find((p) => p.id === 'openai-codex')!, enabled: true });
  cleanup.push(() => store.close());
  const runtime = new Runtime(store, root, () => {});
  cleanup.push(async () => {
    runtime.stop();
    await runtime.waitForIdle();
  });
  const s = store.createSession();
  return {
    root,
    store,
    runtime,
    input: {
      sessionId: s.id,
      providerId: 'openai-codex',
      model: 'fixture-model',
      agentId: '',
      prompt: 'first',
    },
  };
}

function unanswered(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<Message>[] = []) {
  const run: Run = {
    id: 'failed-attempt',
    sessionId: f.input.sessionId,
    providerId: f.input.providerId,
    model: f.input.model,
    agentName: '同舟',
    status: 'failed',
    startedAt: 1,
    endedAt: 2,
    inputTokens: 0,
    outputTokens: 0,
    error: '连接失败',
  };
  f.store.put('run', run);
  const prompt: Message = {
    id: 'unanswered-prompt',
    sessionId: run.sessionId,
    runId: run.id,
    role: 'user',
    content: '原始失败请求',
    createdAt: 1,
    status: 'complete',
  };
  f.store.message(prompt);
  for (const [index, message] of extra.entries())
    f.store.message({ ...prompt, id: 'extra-' + index, role: 'assistant', ...message });
  f.store.message({
    ...prompt,
    id: 'failure-notice',
    role: 'system',
    content: run.error!,
    status: 'error',
  });
  return { run, prompt };
}

describe('editing unanswered messages', () => {
  it('replaces the prompt once, preserves attachments and prior replies, and clears the old error', async () => {
    const f = await fixture();
    f.store.message({
      id: 'previous-user',
      sessionId: f.input.sessionId,
      role: 'user',
      content: '历史问题',
      createdAt: 0,
    });
    f.store.message({
      id: 'previous-reply',
      sessionId: f.input.sessionId,
      role: 'assistant',
      content: '历史回答',
      createdAt: 0,
    });
    const { run, prompt } = unanswered(f, [{ content: '', status: 'error' }]);
    const attachment = new Attachments(f.store, f.root).save({
      name: 'source.txt',
      mimeType: 'text/plain',
      data: Buffer.from('attachment evidence').toString('base64'),
    });
    f.store.message({ ...prompt, attachments: [attachment] });
    const next = f.runtime.start(
      { ...f.input, prompt: '修改后的请求', attachmentIds: [] },
      prompt.id,
    );
    expect(() => f.runtime.start({ ...f.input, prompt: '重复发送' }, prompt.id)).toThrow();
    await f.runtime.waitForIdle();
    const messages = f.store.messages(f.input.sessionId);
    expect(messages.filter((m) => m.id === prompt.id)).toHaveLength(1);
    expect(messages.find((m) => m.id === prompt.id)).toMatchObject({
      content: '修改后的请求',
      runId: next,
      attachments: [attachment],
    });
    expect(messages.some((m) => ['failure-notice', 'extra-0'].includes(m.id))).toBe(false);
    expect(messages.find((m) => m.id === 'previous-reply')?.content).toBe('历史回答');
    expect(f.store.get<Run>('run', run.id).status).toBe('failed');
    expect(f.store.get<Run>('run', next)).toMatchObject({ status: 'completed', retryOf: run.id });
    const input = JSON.stringify(fake.calls.find((c) => c.method === 'turn/start')?.params.input);
    expect(input).toContain('修改后的请求');
    expect(input).not.toContain('原始失败请求');
    expect(input).not.toContain('连接失败');
  });
  it('keeps the failed message and error when the selected connection cannot start', async () => {
    const f = await fixture();
    const { prompt } = unanswered(f);
    const before = f.store.messages(f.input.sessionId);
    f.store.saveProvider({
      ...f.store.providers().find((p) => p.id === f.input.providerId)!,
      enabled: false,
    });
    expect(() => f.runtime.start({ ...f.input, prompt: '修改后的请求' }, prompt.id)).toThrow(
      '已停用',
    );
    expect(f.store.messages(f.input.sessionId)).toEqual(before);
    expect(f.store.list('run')).toHaveLength(1);
  });
  it.each([
    { content: '部分回复', status: 'error' },
    { role: 'tool', content: '工具已经执行' },
    { content: '', toolCalls: [{ id: 'call', name: 'test', arguments: '{}' }] },
  ] as Partial<Message>[])(
    'rejects rewriting a failed attempt that already produced output: %j',
    async (extra) => {
      const f = await fixture();
      const { prompt } = unanswered(f, [extra]);
      const before = f.store.messages(f.input.sessionId);
      expect(() => f.runtime.start({ ...f.input, prompt: '修改' }, prompt.id)).toThrow(
        '未收到回复',
      );
      expect(f.store.messages(f.input.sessionId)).toEqual(before);
    },
  );
  it('rejects reasoning-only output and an older failed turn after a later message', async () => {
    const f = await fixture();
    const { run, prompt } = unanswered(f);
    const event: RunEvent = {
      id: 'thinking',
      sessionId: run.sessionId,
      runId: run.id,
      type: 'reasoning',
      text: '已开始思考',
      seq: 1,
      time: 2,
    };
    f.store.put('runEvent', event);
    expect(() => f.runtime.start({ ...f.input, prompt: '修改' }, prompt.id)).toThrow('未收到回复');
    f.store.remove('runEvent', event.id);
    f.store.message({ ...prompt, id: 'later-user', runId: undefined, content: '后续请求' });
    expect(() => f.runtime.start({ ...f.input, prompt: '修改' }, prompt.id)).toThrow('最后一条');
  });
});
describe('live execution permissions', () => {
  const activeTurn = () => fake.calls.filter((c) => c.method === 'turn/start').at(-1);
  const ready = async (count: number) =>
    vi.waitFor(() =>
      expect(fake.calls.filter((c) => c.method === 'turn/start')).toHaveLength(count),
    );
  const complete = () => {
    const turn = activeTurn();
    const turnId = 'turn-' + fake.next;
    fake.instances.at(-1).complete(turn.params.threadId, turnId);
  };
  it('changes a waiting task to full access with a new sandbox and keeps its prompt, output and run ID', async () => {
    const f = await fixture();
    fake.hold = true;
    const id = f.runtime.start(f.input);
    await ready(1);
    const previousClient = fake.instances.at(-1);
    const turn = activeTurn();
    previousClient.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId: turn.params.threadId, itemId: 'partial', delta: '已完成的分析' },
    });
    previousClient.emit('notification', {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: turn.params.threadId,
        tokenUsage: { total: { inputTokens: 50, outputTokens: 5 } },
      },
    });
    previousClient.emit('request', {
      id: 'waiting-command',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: turn.params.threadId, turnId: 'turn-' + fake.next, command: 'fixture' },
    });
    await vi.waitFor(() => expect(f.runtime.snapshot().approvals).toHaveLength(1));
    f.runtime.setSessionPermission(f.input.sessionId, 'full-access');
    await ready(2);
    expect(previousClient.stopped).toBe(true);
    expect(f.runtime.snapshot().approvals).toHaveLength(0);
    expect(fake.replies.find((r) => r.id === 'waiting-command').result.decision).toBe('decline');
    expect(fake.calls.filter((c) => c.method === 'thread/start').at(-1).params).toMatchObject({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(activeTurn().params.input[0].text).toContain('已完成的分析');
    expect(activeTurn().params.input[0].text).toContain('必须先读取现状再继续');
    expect(f.store.get<Run>('run', id)).toMatchObject({
      status: 'running',
      config: { permission: 'full-access' },
    });
    expect(
      await f.runtime.ask(f.input.sessionId, 'next tool', '{}', new AbortController().signal),
    ).toBe(true);
    complete();
    await f.runtime.waitForIdle();
    expect(f.store.list<Run>('run')).toHaveLength(1);
    expect(f.store.messages(f.input.sessionId).filter((m) => m.role === 'user')).toHaveLength(1);
    expect(
      f.store.messages(f.input.sessionId).find((m) => m.content === '已完成的分析')?.status,
    ).toBe('interrupted');
    expect(f.store.get<Run>('run', id)).toMatchObject({
      status: 'completed',
      inputTokens: 150,
      outputTokens: 15,
    });
  });
  it('rebuilds tool capabilities on read-only changes and returns to approval mode in the same task', async () => {
    const f = await fixture();
    f.store.put('project', { id: 'project', name: 'fixture', path: f.root, createdAt: Date.now() });
    f.store.put('session', {
      ...f.store.get<any>('session', f.input.sessionId),
      projectId: 'project',
    });
    f.runtime.setSessionPermission(f.input.sessionId, 'full-access');
    fake.hold = true;
    const id = f.runtime.start(f.input);
    await ready(1);
    f.runtime.setSessionPermission(f.input.sessionId, 'read-only');
    await ready(2);
    const readonly = fake.calls.filter((c) => c.method === 'thread/start').at(-1).params;
    expect(readonly.sandbox).toBe('read-only');
    expect(readonly.config['features.shell_tool']).toBe(false);
    expect(readonly.dynamicTools.some((t: any) => t.name === 'write_file')).toBe(false);
    f.runtime.setSessionPermission(f.input.sessionId, 'ask');
    await ready(3);
    const asking = fake.calls.filter((c) => c.method === 'thread/start').at(-1).params;
    expect(asking).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'untrusted' });
    expect(asking.dynamicTools.some((t: any) => t.name === 'write_file')).toBe(true);
    const decision = f.runtime.ask(
      f.input.sessionId,
      'requires approval',
      '{}',
      new AbortController().signal,
    );
    const approval = f.runtime.snapshot().approvals[0];
    expect(approval).toBeDefined();
    f.runtime.approve(approval.id, false);
    expect(await decision).toBe(false);
    complete();
    await f.runtime.waitForIdle();
    expect(f.store.get<Run>('run', id).status).toBe('completed');
    expect(f.store.list<Run>('run')).toHaveLength(1);
  });
  it('uses the latest selection when changed before startup or repeatedly during reconnection', async () => {
    const f = await fixture();
    fake.hold = true;
    f.runtime.start(f.input);
    f.runtime.setSessionPermission(f.input.sessionId, 'full-access');
    await ready(1);
    expect(fake.calls.find((c) => c.method === 'thread/start').params.sandbox).toBe(
      'danger-full-access',
    );
    f.runtime.setSessionPermission(f.input.sessionId, 'read-only');
    f.runtime.setSessionPermission(f.input.sessionId, 'ask');
    f.runtime.setSessionPermission(f.input.sessionId, 'full-access');
    await ready(2);
    expect(fake.calls.filter((c) => c.method === 'thread/start').at(-1).params.sandbox).toBe(
      'danger-full-access',
    );
    await f.runtime.cancel(f.input.sessionId);
    await f.runtime.waitForIdle();
    expect(f.store.list<Run>('run')[0].status).toBe('interrupted');
  });
  it('updates inherited global permissions, preserves overrides and keeps read-only Agents locked', async () => {
    const f = await fixture();
    fake.hold = true;
    f.runtime.start(f.input);
    await ready(1);
    f.runtime.setDefaultPermission('full-access');
    await ready(2);
    f.runtime.setSessionPermission(f.input.sessionId, 'ask');
    await ready(3);
    f.runtime.setDefaultPermission('read-only');
    expect(fake.calls.filter((c) => c.method === 'turn/start')).toHaveLength(3);
    f.runtime.setDefaultPermission('read-only', true);
    await ready(4);
    expect(f.store.get<Run>('run', f.store.list<Run>('run')[0].id).config?.permission).toBe(
      'read-only',
    );
    complete();
    await f.runtime.waitForIdle();
    f.store.put('agent', {
      id: 'readonly-agent',
      name: '只读助手',
      instructions: '',
      permission: 'read-only',
      providerId: '',
      model: '',
      maxSteps: 0,
    });
    f.runtime.start({ ...f.input, agentId: 'readonly-agent' });
    await ready(5);
    f.runtime.setSessionPermission(f.input.sessionId, 'full-access');
    expect(fake.calls.filter((c) => c.method === 'turn/start')).toHaveLength(5);
    expect(f.store.list<Run>('run').at(-1)?.config?.permission).toBe('read-only');
    complete();
    await f.runtime.waitForIdle();
  });
});
describe('locked Codex resume and steer contracts', () => {
  it.each(['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'minimax', 'kimi'] as const)(
    'always delegates %s conversations to Codex with a model-only transport',
    async (protocol) => {
      const f = await fixture();
      f.store.saveProvider({
        id: 'adapter',
        name: 'adapter',
        protocol,
        auth: 'none',
        baseUrl: 'https://unused.invalid',
        models: ['fixture-model'],
        maxOutputTokens: 1000,
        contextChars: 0,
      });
      f.runtime.start({ ...f.input, providerId: 'adapter' });
      await f.runtime.waitForIdle();
      expect(f.store.list<any>('run')[0].status).toBe('completed');
      expect(fake.calls.find((c) => c.method === 'thread/start')?.params.modelProvider).toBe(
        'tongzhou-model',
      );
      expect(
        fake.calls.some((c) => c.method === 'account/read' || c.method === 'session/prompt'),
      ).toBe(false);
      expect(
        fake.instances.some((c) => c.modelTransport?.baseUrl.startsWith('http://127.0.0.1:')),
      ).toBe(true);
    },
  );

  it('applies default thinking and changes the next turn without reusing stale settings', async () => {
    const f = await fixture();
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'turn/start').at(-1).params.effort).toBe('medium');
    const p = f.store.providers().find((p) => p.id === f.input.providerId)!;
    f.store.saveProvider({ ...p, thinkingEnabled: false });
    f.runtime.start({ ...f.input, prompt: 'next' });
    await f.runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'turn/start').at(-1).params.effort).toBe('none');
    expect(fake.calls.filter((c) => c.method === 'thread/start')).toHaveLength(2);
  });

  it('passes account-scoped networking to login and inference and resets only that account', async () => {
    const f = await fixture();
    const base = f.store.providers().find((p) => p.id === f.input.providerId)!;
    const network = { mode: 'proxy' as const, proxyUrl: 'http://127.0.0.1:7890' };
    f.store.saveProvider({ ...base, network });
    f.store.saveProvider({ ...base, id: 'other-account', network: { mode: 'direct' } });
    const other = f.runtime.authClientFor('other-account');
    f.runtime.resetCodexAccount(base.id);
    expect((f.runtime.authClientFor(base.id) as any).network).toEqual(network);
    expect(f.runtime.authClientFor('other-account')).toBe(other);
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    expect(fake.instances.at(-1).network).toEqual(network);
    expect((other as any).network).toEqual({ mode: 'direct' });
  });
  it('maps a project full-access override to Codex and rebuilds when permission changes', async () => {
    const f = await fixture();
    f.store.put('project', {
      id: 'project',
      name: 'fixture',
      path: f.root,
      createdAt: Date.now(),
    });
    const session = f.store.get<any>('session', f.input.sessionId);
    f.store.put('session', { ...session, projectId: 'project' });
    f.store.setSessionPermission(session.id, 'full-access');
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    expect(fake.calls.find((c) => c.method === 'thread/start').params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    f.store.setSessionPermission(session.id, 'read-only');
    f.runtime.start({ ...f.input, prompt: 'only read now' });
    await f.runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'thread/start')).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === 'thread/start').at(-1).params.sandbox).toBe(
      'read-only',
    );
  });
  it('reuses the live thread without resuming, isolates turn listeners, and rebuilds after a model change', async () => {
    const f = await fixture();
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    const client = fake.instances.at(-1);
    f.runtime.start({ ...f.input, prompt: 'second' });
    await f.runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'thread/start')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'thread/resume')).toHaveLength(0);
    expect(fake.instances.at(-1)).toBe(client);
    expect(client.stopped).toBe(false);
    expect(client.listenerCount('notification')).toBe(0);
    expect(client.listenerCount('request')).toBe(1);
    expect(f.store.messages(f.input.sessionId).filter((m) => m.role === 'assistant')).toHaveLength(
      2,
    );
    expect(fake.calls.filter((c) => c.method === 'turn/start')[1].params.input[0].text).toBe(
      'second',
    );
    expect(f.store.list<any>('run').map((r) => r.inputTokens)).toEqual([100, 100]);
    f.runtime.start({ ...f.input, model: 'different-model', prompt: 'third' });
    await f.runtime.waitForIdle();
    expect(client.stopped).toBe(true);
    expect(fake.calls.filter((c) => c.method === 'thread/start')).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === 'turn/start')[2].params.input[0].text).toContain(
      'Verified reply',
    );
  });
  it('resumes persisted history after account reset and resolves the network before every turn', async () => {
    const f = await fixture();
    const resolve = vi.fn(async (network) => network);
    f.runtime.resolveNetwork = resolve;
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    const old = fake.instances.at(-1);
    f.runtime.resetCodexAccount(f.input.providerId);
    expect(old.stopped).toBe(true);
    f.runtime.start({ ...f.input, prompt: 'second' });
    await f.runtime.waitForIdle();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fake.calls.filter((c) => c.method === 'thread/resume')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'turn/start').at(-1).params.input[0].text).toBe(
      'second',
    );
    const latest = fake.instances.at(-1);
    await f.runtime.deleteSession(f.input.sessionId);
    expect(latest.stopped).toBe(true);
  });
  it('passes actual images into Codex turns and model handoffs', async () => {
    const f = await fixture();
    const a = new Attachments(f.store, f.runtime.dataDir).save({
      name: 'p.png',
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    });
    f.runtime.start({ ...f.input, prompt: '', attachmentIds: [a.id] });
    await f.runtime.waitForIdle();
    f.runtime.start({ ...f.input, prompt: '继续看图', model: 'other' });
    await f.runtime.waitForIdle();
    const turns = fake.calls.filter((c) => c.method === 'turn/start');
    expect(turns).toHaveLength(2);
    expect(
      turns.every((t) =>
        t.params.input.some(
          (i: any) => i.type === 'image' && i.url.startsWith('data:image/png;base64,'),
        ),
      ),
    ).toBe(true);
  });
  it('pauses an unacknowledged steer without duplicating it or claiming application', async () => {
    fake.hold = true;
    fake.loseSteer = true;
    const f = await fixture();
    f.runtime.start(f.input);
    await expect.poll(() => fake.calls.some((c) => c.method === 'turn/start')).toBe(true);
    await expect(
      f.runtime.enqueue({ ...f.input, prompt: 'new constraint' }, 'supplement'),
    ).rejects.toThrow('未获确认');
    const pending = f.runtime.snapshot().pendingInputs![0];
    expect(pending.status).toBe('paused');
    expect(fake.calls.find((c) => c.method === 'turn/steer').params).toMatchObject({
      expectedTurnId: 'turn-2',
      clientUserMessageId: pending.id,
    });
    expect(f.store.messages(f.input.sessionId).some((m) => m.content === 'new constraint')).toBe(
      false,
    );
    await f.runtime.cancel(f.input.sessionId);
    await f.runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'turn/steer')).toHaveLength(1);
  });
  it('edits only unconsumed inputs and applies the final text once', async () => {
    fake.hold = true;
    const f = await fixture();
    f.runtime.start(f.input);
    await expect.poll(() => fake.calls.some((c) => c.method === 'turn/start')).toBe(true);
    await f.runtime.enqueue({ ...f.input, prompt: 'old queued' }, 'next');
    const queued = f.runtime.snapshot().pendingInputs![0];
    f.runtime.editInput(queued.id, 'edited queued');
    fake.hold = false;
    fake.instances.at(-1).complete('thread-1', 'turn-2');
    await f.runtime.waitForIdle();
    expect(
      f.store
        .messages(f.input.sessionId)
        .filter((m) => m.role === 'user')
        .map((m) => m.content),
    ).toEqual(['first', 'edited queued']);
    expect(() => f.runtime.editInput(queued.id, 'late')).toThrow('已送交');
  });
  it('steers attachments into the active Codex turn and persists them on the supplement', async () => {
    fake.hold = true;
    const f = await fixture();
    const a = new Attachments(f.store, f.runtime.dataDir).save({
      name: 'notes.txt',
      mimeType: 'text/plain',
      data: Buffer.from('补充资料').toString('base64'),
    });
    f.runtime.start(f.input);
    await expect.poll(() => fake.calls.some((c) => c.method === 'turn/start')).toBe(true);
    await f.runtime.enqueue({ ...f.input, prompt: '', attachmentIds: [a.id] }, 'supplement');
    expect(fake.calls.find((c) => c.method === 'turn/steer').params.input[0].text).toContain(a.id);
    expect(
      f.store
        .messages(f.input.sessionId)
        .filter((m) => m.role === 'user')
        .at(-1)?.attachments?.[0].id,
    ).toBe(a.id);
    await f.runtime.cancel(f.input.sessionId);
    await f.runtime.waitForIdle();
  });
});
