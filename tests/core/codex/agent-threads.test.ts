import { expect, it, vi } from 'vitest';
import { AgentThreads } from '../../../electron/core/codex/agent-threads';
import { ToolScope } from '../../../electron/core/tools/extensions';
import type { CodexClient } from '../../../electron/core/codex/codex';
import type { ChildAgent } from '../../../src/shared/agent-execution';

function fixture(previous: any[] = []) {
  const snapshots: any[] = [];
  const scopes: ToolScope[] = [];
  let enabled = true;
  const ask = vi.fn(async () => true);
  const spec = {
    name: 'work',
    description: 'work',
    parameters: { type: 'object', properties: {} },
  };
  const prepare = async (signal: AbortSignal) => {
    const scope = new ToolScope(signal, ask, () => {});
    scope.add(
      spec,
      'work',
      async () =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled work')), {
            once: true,
          }),
        ),
    );
    scopes.push(scope);
    return scope;
  };
  const root = new ToolScope(new AbortController().signal, ask, () => {});
  root.add(
    spec,
    'work',
    async () => ({ text: 'root' }),
    true,
    () => enabled,
  );
  const request = vi.fn(async (method, params) =>
    method === 'thread/resume'
      ? { thread: { id: params.threadId, parentThreadId: 'root', model: 'gpt-6-sol', turns: [] } }
      : method === 'turn/start'
        ? { turn: { id: 'resumed' } }
        : {},
  );
  const tree = new AgentThreads(
    { request } as unknown as CodexClient,
    new AbortController().signal,
    root,
    prepare,
    (agents) => snapshots.push(agents),
    { previous, model: 'gpt-6-sol', effort: 'high' },
  );
  tree.root = 'root';
  tree.observe('turn/started', { threadId: 'root', turn: { id: 'main' } });
  const spawn = (id: string, parent = 'root') => {
    tree.observe('thread/started', {
      thread: { id, parentThreadId: parent, model: 'gpt-6-sol', agentNickname: id },
    });
    tree.observe('turn/started', { threadId: id, turn: { id: 'turn-' + id } });
  };
  return {
    tree,
    root,
    request,
    ask,
    scopes,
    snapshots,
    spawn,
    disable: () => {
      enabled = false;
    },
  };
}
it('owns only its descendants, rejects foreign requests and preserves the root catalogue guard', async () => {
  const f = fixture();
  f.spawn('child');
  f.spawn('grandchild', 'child');
  f.spawn('foreign', 'unrelated');
  expect(f.tree.accepts('grandchild', 'turn-grandchild')).toBe(true);
  expect(f.tree.accepts('foreign')).toBe(false);
  expect(f.tree.accepts('child', 'wrong-turn')).toBe(false);
  await Promise.resolve();
  f.tree.observe('model/rerouted', { threadId: 'child', toModel: 'reported-fallback' });
  expect(f.snapshots.at(-1)?.find((a: ChildAgent) => a.threadId === 'child')?.model).toBe(
    'reported-fallback',
  );
  f.disable();
  await expect(f.tree.tools('child', 'work')).rejects.toThrow('停用');
  expect(f.scopes).toHaveLength(0);
  await f.tree.close();
  await f.root.close();
});
it('cancels only one child, releases its tools, and resumes with a fresh cancellation scope', async () => {
  const f = fixture();
  f.spawn('one');
  f.spawn('two');
  const one = await f.tree.tools('one', 'work');
  const work = one.call('work', {});
  await vi.waitFor(() => expect(f.ask).toHaveBeenCalled());
  await f.tree.control('one', 'interrupt');
  expect((await work).isError).toBe(true);
  expect(f.tree.signalFor('two').aborted).toBe(false);
  await f.tree.control('one', 'resume');
  f.tree.observe('turn/started', { threadId: 'one', turn: { id: 'resumed' } });
  f.tree.observe('turn/completed', {
    threadId: 'one',
    turn: { id: 'turn-one', status: 'completed' },
  });
  expect(f.tree.signalFor('one').aborted).toBe(false);
  expect(await f.tree.tools('one', 'work')).not.toBe(one);
  await f.tree.close();
  expect(f.snapshots.at(-1).every((agent: any) => agent.status === 'interrupted')).toBe(true);
  expect(f.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'two', turnId: 'turn-two' });
  await f.root.close();
});
it('keeps a failed child failed and refuses controls after the parent closes', async () => {
  const f = fixture();
  f.spawn('child');
  f.tree.observe('turn/completed', {
    threadId: 'child',
    turn: { id: 'turn-child', status: 'failed', error: { message: 'fixture failure' } },
  });
  await f.tree.close();
  expect(f.snapshots.at(-1)[0]).toMatchObject({ status: 'failed', message: 'fixture failure' });
  await expect(f.tree.control('child', 'resume')).rejects.toThrow('当前运行');
  await f.root.close();
});
it('counts only new child usage after resuming a saved thread', async () => {
  const f = fixture([{ threadId: 'child', usageTotal: { inputTokens: 300, outputTokens: 30 } }]);
  f.spawn('child');
  f.tree.observe('thread/tokenUsage/updated', {
    threadId: 'child',
    tokenUsage: { total: { inputTokens: 420, outputTokens: 45 } },
  });
  expect(f.tree.usage()).toEqual({ inputTokens: 120, outputTokens: 15, incomplete: false });
  expect(f.snapshots.at(-1)[0].usageTotal).toEqual({ inputTokens: 420, outputTokens: 45 });
  await f.tree.close();
  await f.root.close();
});
