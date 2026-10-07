import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../electron/services/storage/store';
import { Runtime } from '../../electron/core/runtime/runtime';
import { Attachments } from '../../electron/modules/artifacts/attachments';

const fake = vi.hoisted(() => ({
  calls: [] as any[],
  instances: [] as any[],
  hold: false,
  loseSteer: false,
  next: 0,
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
      reply() {}
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
