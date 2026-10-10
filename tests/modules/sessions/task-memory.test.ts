import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../../electron/services/storage/store';
import { TaskMemories, recallInstructions } from '../../../electron/modules/sessions/task-memory';
import type { Session, Message } from '../../../src/shared/types';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  cleanup.push(() => store.close());
  const memories = new TaskMemories(store);
  const chat = store.createSession();
  function tools(sessionId = chat.id) {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    memories.attach(
      { add: (spec: any, _title: any, fn: any) => handlers.set(spec.name, fn) } as any,
      sessionId,
    );
    return {
      search: async (args: any) => JSON.parse((await handlers.get('search_history')!(args)).text),
      read: async (args: any) => JSON.parse((await handlers.get('read_history')!(args)).text),
    };
  }
  function message(
    session: Session,
    id: string,
    createdAt: number,
    role: Message['role'] = 'user',
  ) {
    store.message({ id, sessionId: session.id, createdAt, role, content: `原文 ${id}` });
  }
  return { store, chat, tools, message };
}
describe('conversation recall', () => {
  it('recalls archived chats by local calendar boundaries and pages without duplicates', async () => {
    const { store, chat, tools, message } = fixture();
    const old = store.createSession();
    store.put('session', { ...old, title: '昨日讨论', archived: true });
    const midnight = new Date(2026, 9, 9).getTime();
    message(old, 'before', midnight - 1);
    message(old, 'first', midnight);
    message(old, 'second', new Date(2026, 9, 9, 23, 59, 59, 999).getTime(), 'assistant');
    message(old, 'after', new Date(2026, 9, 10).getTime());
    message(old, 'internal', midnight + 2, 'tool');
    message(chat, 'today', new Date(2026, 9, 10, 12).getTime());
    for (const boundary of [
      { knowledgeJob: true },
      { memoryJob: 'job' },
      { automationJob: 'job' },
      { parentId: chat.id },
      { contentContext: { libraryId: 'l', documentId: 'd' } },
    ]) {
      const worker = store.createSession();
      store.put('session', { ...worker, ...boundary });
      message(worker, worker.id, midnight + 1);
    }
    const t = tools();
    expect(await t.search({ query: '' })).toHaveLength(1);
    const args = {
      scope: 'all',
      query: '',
      startDate: '2026-10-09',
      endDate: '2026-10-10',
      limit: 1,
    };
    const page1 = await t.search(args);
    expect(page1.results).toMatchObject([
      { id: 'second', sessionId: old.id, sessionTitle: '昨日讨论' },
    ]);
    const page2 = await t.search({ ...args, before: page1.nextBefore });
    expect(page2.results.map((m: any) => m.id)).toEqual(['first']);
    expect((await t.search({ ...args, before: page2.nextBefore })).results).toEqual([]);
    expect(
      (await t.read({ sessionId: old.id, messageId: 'first', offset: 0, limit: 2 })).content,
    ).toBe('原文');
    expect((await t.read({ sessionId: old.id, messageId: 'first', offset: 2 })).content).toBe(
      ' first',
    );
    expect(
      (await t.search({ scope: 'all', query: 'second', role: 'assistant' })).results.map(
        (m: any) => m.id,
      ),
    ).toEqual(['second']);
    await expect(t.read({ sessionId: old.id, messageId: 'internal' })).rejects.toThrow('跨会话');
    await expect(t.read({ messageId: 'first' })).rejects.toThrow('不存在');
  });
  it('keeps worker history scoped even if broader arguments are supplied', async () => {
    const { store, chat, tools, message } = fixture();
    message(chat, 'private', Date.now());
    const worker = store.createSession();
    store.put('session', { ...worker, knowledgeJob: true });
    message(worker, 'source', Date.now());
    const t = tools(worker.id);
    expect((await t.search({})).map((m: any) => m.id)).toEqual(['source']);
    await expect(t.search({ scope: 'all' })).rejects.toThrow('当前会话');
    await expect(t.read({ sessionId: chat.id, messageId: 'private' })).rejects.toThrow('不能读取');
    await expect(tools().read({ sessionId: worker.id, messageId: 'source' })).rejects.toThrow(
      '不能读取',
    );
  });
  it('rejects invalid or reversed dates and uses the actual local date in instructions', async () => {
    const { tools } = fixture();
    await expect(tools().search({ scope: 'all', startDate: '2026-02-30' })).rejects.toThrow(
      '日期不存在',
    );
    await expect(
      tools().search({ startDate: '2026-10-10', endDate: '2026-10-09' }),
    ).rejects.toThrow('晚于');
    await expect(tools().search({ scope: 'all', role: 'tool' })).rejects.toThrow('跨会话');
    expect(recallInstructions(new Date(2026, 9, 10, 0, 1))).toContain('2026-10-10');
    expect(recallInstructions()).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
