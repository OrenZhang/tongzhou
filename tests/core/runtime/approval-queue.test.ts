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
  return { queue, session, changed };
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
