import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalQueue } from '../../../electron/core/runtime/approval-queue';
import { Store } from '../../../electron/services/storage/store';
const stores: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  stores.push(store);
  const session = store.createSession();
  const changed = vi.fn();
  const emit = vi.fn();
  const queue = new ApprovalQueue(store, emit, changed, () => {});
  return { queue, session, changed, store };
}
it('settles an approval once and detaches its abort listener', async () => {
  const { queue, session, changed } = fixture();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const result = queue.ask(session.id, 'execute', 'detail', controller.signal);
  const id = queue.snapshot()[0].id;
  queue.approve(id, true);
  expect(await result).toBe(true);
  expect(queue.snapshot()).toEqual([]);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  controller.abort();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(() => queue.approve(id, true)).toThrow('已失效');
});
const question = {
  id: 'scope',
  header: '范围',
  question: '选择处理范围',
  isOther: true,
  isSecret: false,
  options: [
    { label: 'A', description: '当前目录' },
    { label: 'B', description: '全部' },
  ],
};
it('never auto-answers questions in full access, validates answers, and preserves only metadata', async () => {
  const { queue, session, store } = fixture();
  store.put('run', {
    id: 'run',
    sessionId: session.id,
    status: 'running',
    config: { permission: 'full-access' },
  });
  const controller = new AbortController();
  const pending = queue.question(
    session.id,
    'run',
    { threadId: 'thread', questions: [question], isBlocking: true },
    controller.signal,
  );
  const request = queue.snapshot()[0];
  expect(request.kind).toBe('question');
  expect(() => queue.approve(request.id, true)).toThrow('追问');
  expect(() => queue.answer(request.id, { foreign: ['A'] })).toThrow('所有问题');
  queue.answer(request.id, { scope: ['自定义范围'] });
  expect(await pending).toEqual({ scope: ['自定义范围'] });
  controller.abort();
  expect(store.get<any>('userQuestion', request.id).status).toBe('answered');
  expect(JSON.stringify(store.list('userQuestion'))).not.toContain('自定义范围');
  expect(() => queue.answer(request.id, { scope: ['A'] })).toThrow('失效');
});
it('checks fixed options, secret input and duplicate IDs without accepting fabricated replies', async () => {
  const { queue, session, store } = fixture();
  expect(() =>
    queue.question(
      session.id,
      'run',
      { threadId: 'thread', questions: [question, question], isBlocking: true },
      new AbortController().signal,
    ),
  ).toThrow('重复');
  const pending = queue.question(
    session.id,
    'run',
    {
      threadId: 'thread',
      questions: [
        { ...question, isOther: false },
        { ...question, id: 'secret', isSecret: true, options: null },
      ],
      isBlocking: true,
    },
    new AbortController().signal,
  );
  const request = queue.snapshot()[0];
  expect(() => queue.answer(request.id, { scope: ['invented'], secret: ['fake-secret'] })).toThrow(
    '选项',
  );
  queue.answer(request.id, { scope: ['A'], secret: ['fake-secret'] });
  expect(await pending).toEqual({ scope: ['A'], secret: ['fake-secret'] });
  expect(JSON.stringify(store.list('userQuestion'))).not.toContain('fake-secret');
});
it('expires optional questions and cancels requests on session removal, shutdown and process recovery', async () => {
  vi.useFakeTimers();
  const { queue, session, store } = fixture();
  const pending = queue.question(
    session.id,
    'run',
    { threadId: 'thread', questions: [question], isBlocking: false, autoResolutionMs: 50 },
    new AbortController().signal,
  );
  const id = queue.snapshot()[0].id;
  await vi.advanceTimersByTimeAsync(50);
  expect(await pending).toBeNull();
  expect(store.get<any>('userQuestion', id).status).toBe('expired');
  const next = queue.question(
    session.id,
    'run',
    { threadId: 'thread', questions: [question], isBlocking: true },
    new AbortController().signal,
  );
  queue.cancelSession(session.id);
  expect(await next).toBeNull();
  store.put('userQuestion', { id: 'stale', sessionId: session.id, status: 'pending' });
  const restored = new ApprovalQueue(
    store,
    () => {},
    () => {},
    () => {},
  );
  expect(restored.snapshot()).toEqual([]);
  expect(store.get<any>('userQuestion', 'stale').status).toBe('cancelled');
  restored.dispose();
  queue.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects pending decisions on shutdown and accepts no new approvals', async () => {
  const { queue, session } = fixture();
  const result = queue.ask(session.id, 'execute', 'detail', new AbortController().signal);
  queue.dispose();
  queue.dispose();
  expect(await result).toBe(false);
  expect(queue.snapshot()).toEqual([]);
  expect(await queue.ask(session.id, 'execute', 'detail', new AbortController().signal)).toBe(
    false,
  );
});
it('rejects aborted and expired decisions without retaining timers', async () => {
  vi.useFakeTimers();
  const { queue, session } = fixture();
  const controller = new AbortController();
  const aborted = queue.ask(session.id, 'execute', 'detail', controller.signal);
  controller.abort();
  expect(await aborted).toBe(false);
  const expired = queue.ask(session.id, 'execute', 'detail', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(await expired).toBe(false);
  expect(queue.snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
