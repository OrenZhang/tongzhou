import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { Runtime } from '../electron/runtime';

const fake = vi.hoisted(() => ({
  calls: [] as any[],
  instances: [] as any[],
  hold: false,
  loseSteer: false,
  next: 0,
}));
vi.mock('../electron/codex', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    CodexClient: class extends EventEmitter {
      constructor(public home: string) {
        super();
        fake.instances.push(this);
      }
      async start() {}
      stop() {}
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
  it('resumes continuous history but rebuilds after changing model', async () => {
    const f = await fixture();
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    f.runtime.start({ ...f.input, prompt: 'second' });
    await f.runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'thread/start')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'thread/resume')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'turn/start')[1].params.input[0].text).toBe(
      'second',
    );
    expect(f.store.list<any>('run').map((r) => r.inputTokens)).toEqual([100, 100]);
    f.runtime.start({ ...f.input, model: 'different-model', prompt: 'third' });
    await f.runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'thread/start')).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === 'turn/start')[2].params.input[0].text).toContain(
      'Verified reply',
    );
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
});
