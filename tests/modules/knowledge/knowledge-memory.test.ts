import { authorizeKnowledgeFixtures } from '../../support/knowledge-fixture';
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { Knowledge } from '../../../electron/modules/knowledge/knowledge';
import {
  DataMaintenance,
  applyPendingRestore,
} from '../../../electron/services/storage/data-maintenance';
import type { Run } from '../../../src/shared/types';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-daily-memory-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'tongzhou.db'), { encrypt: (s) => s, decrypt: (s) => s });
  cleanup.push(() => store.close());
  const k = new Knowledge(store, root);
  function enqueue(id: string, content: string, project?: string, timestamp = Date.now()) {
    if (project && !store.list<any>('project').some((p) => p.id === project))
      store.put('project', { id: project, name: project, path: root });
    const session = store.createSession(project);
    store.put('session', { ...session, providerId: 'test', model: 'mock' });
    store.message({
      id: id + 'u',
      sessionId: session.id,
      runId: id,
      role: 'user',
      content,
      createdAt: timestamp,
    });
    store.message({
      id: id + 'a',
      sessionId: session.id,
      runId: id,
      role: 'assistant',
      content: '已记录，需要验证。',
      createdAt: timestamp + 1,
    });
    const run = {
      id,
      sessionId: session.id,
      providerId: 'test',
      model: 'mock',
      status: 'completed',
      startedAt: timestamp,
    } as Run;
    k.capture(run);
    return { run, session };
  }
  function commit(candidateId: string, quote: string, content = quote) {
    const work = k.memory.claim(true)!;
    k.memory.commit(work.job.id, {
      entries: [
        {
          category: 'decision',
          subject: '接口规则',
          relation: '采用',
          content,
          evidence: [{ candidateId, quote }],
        },
      ],
    });
    return work;
  }
  return { root, store, k, enqueue, commit };
}
describe('daily memory consolidation', () => {
  it('accepts user-grounded preferences but rejects assistant self-description', () => {
    const { k, enqueue } = fixture();
    enqueue('style', '以后请先给结论，再补充原因');
    const work = k.memory.claim(true)!;
    const entry = {
      category: 'preference',
      subject: '用户',
      relation: '表达偏好',
      content: '先给结论，再补充原因',
    };
    expect(() =>
      k.memory.commit(work.job.id, {
        entries: [{ ...entry, evidence: [{ candidateId: 'style', quote: '已记录，需要验证' }] }],
      }),
    ).toThrow('偏好必须引用本轮用户原文');
    k.memory.commit(work.job.id, {
      entries: [
        { ...entry, evidence: [{ candidateId: 'style', quote: '以后请先给结论，再补充原因' }] },
      ],
    });
    expect(k.all()[0].memoryEntries?.[0]).toMatchObject({
      category: 'preference',
      quotes: ['以后请先给结论，再补充原因'],
    });
  });
  it('has one daily page across scopes while retrieval and tools isolate each project', async () => {
    const { k, enqueue, commit } = fixture();
    const a = enqueue('a', '订单接口采用甲方规范', 'a');
    commit('a', '订单接口采用甲方规范');
    const b = enqueue('b', '订单接口采用乙方规范', 'b');
    commit('b', '订单接口采用乙方规范');
    expect(k.all().filter((d) => d.kind === 'memory')).toHaveLength(1);
    const day = k.all()[0];
    expect(day.memoryEntries).toHaveLength(2);
    expect(existsSync(path.join(k.root, 'memories', day.memoryDate!, 'index.md'))).toBe(true);
    expect(k.search('订单', a.session.id)[0].excerpt).toContain('甲方');
    expect(JSON.stringify(k.search('订单', a.session.id))).not.toContain('乙方');
    expect(JSON.stringify(k.search('订单', b.session.id))).not.toContain('甲方');
    const handlers = new Map<string, any>();
    k.attach(
      { add: (spec: any, _title: any, fn: any) => handlers.set(spec.name, fn) } as any,
      a.session.id,
      true,
      () => {},
    );
    expect((await handlers.get('knowledge_read')({ id: day.id })).text).not.toContain('乙方');
    expect(k.search('订单', a.session.id)[0].status).toBe('draft');
    k.review(day.id, day.version);
    expect((await handlers.get('knowledge_read')({ id: day.id })).text).toContain('甲方');
    expect((await handlers.get('knowledge_read')({ id: day.id })).text).not.toContain('乙方');
    const c = enqueue('c', '订单错误码固定为 ORDER_INVALID', 'a');
    commit(c.run.id, '订单错误码固定为 ORDER_INVALID');
    const updated = k.get(day.id);
    expect(updated.status).toBe('draft');
    expect(updated.memoryEntries?.[0].reviewedAt).toBeTruthy();
    expect(updated.memoryEntries?.at(-1)?.reviewedAt).toBeUndefined();
  });
  it('skips noise, rejects fabricated evidence, recovers interruption and stops after bounded failures', () => {
    const { k, enqueue, store, root } = fixture();
    enqueue('smalltalk', '今天你好呀');
    let work = k.memory.claim(true)!;
    expect(() =>
      k.memory.commit(work.job.id, {
        entries: [
          {
            category: 'fact',
            subject: '库存',
            relation: '数值',
            content: '库存10',
            evidence: [{ candidateId: 'smalltalk', quote: '根本没有此原文' }],
          },
        ],
      }),
    ).toThrow('原文不匹配');
    expect(k.all()).toHaveLength(0);
    const reopened = new Knowledge(store, root);
    expect(reopened.memory.queueState().failed).toBe(1);
    reopened.memory.retry();
    work = reopened.memory.claim(true)!;
    reopened.memory.commit(work.job.id, { entries: [], skippedReason: '仅为问候，无持久信息' });
    expect(reopened.all()).toHaveLength(0);
    expect(reopened.memory.queueState().pending).toBe(0);
    expect(reopened.memory.claim(true)).toBeUndefined();
  });
  it('partitions dates and keeps deleted days from reappearing', () => {
    const { k, enqueue, commit } = fixture();
    const day = new Date(2026, 9, 4, 23, 59).getTime();
    enqueue('before', '昨日库存规则需要复核', undefined, day);
    commit('before', '昨日库存规则需要复核');
    enqueue('after', '今日库存改为预占模式', undefined, day + 120000);
    commit('after', '今日库存改为预占模式');
    expect(
      k
        .all()
        .map((d) => d.memoryDate)
        .sort(),
    ).toEqual(['2026-10-04', '2026-10-05']);
    const old = k.all()[0];
    k.delete(old.id, old.version);
    enqueue('late', '昨日补充资料仍有价值', undefined, day);
    expect(k.memory.claim(true)).toBeUndefined();
    expect(k.all()).toHaveLength(1);
    expect(existsSync(path.join(k.root, 'memories', old.memoryDate!, 'index.md'))).toBe(false);
  });
  it('migrates old per-turn records without breaking source IDs, and backs up dated files', () => {
    const { k, store, root, enqueue } = fixture();
    const { session } = enqueue('old', '库存使用事务更新');
    const legacy = k.save(
      { title: '旧记忆', kind: 'memory', content: '库存使用事务更新' },
      'automatic',
      { sessionId: session.id, runId: 'legacy' },
    );
    const restarted = new Knowledge(store, root);
    expect(restarted.get(legacy.id).kind).toBe('source');
    expect(existsSync(path.join(k.root, 'memories', legacy.id + '.md'))).toBe(false);
    const work = restarted.memory.claim(true)!;
    restarted.memory.commit(work.job.id, {
      entries: [
        {
          category: 'fact',
          subject: '库存',
          relation: '更新方式',
          content: '库存使用事务更新',
          evidence: [{ candidateId: work.job.candidateIds[0], quote: '库存使用事务更新' }],
        },
      ],
    });
    const memory = restarted.all().find((d) => d.memoryDate)!;
    const bytes = new DataMaintenance(store, root).backup('test-backup-password');
    const target = mkdtempSync(path.join(tmpdir(), 'tongzhou-daily-restore-'));
    cleanup.push(() => rmSync(target, { recursive: true, force: true }));
    new DataMaintenance(store, target).prepareRestore(bytes, 'test-backup-password');
    applyPendingRestore(target);
    expect(
      readFileSync(
        path.join(target, 'knowledge', 'memories', memory.memoryDate!, 'index.md'),
        'utf8',
      ),
    ).toContain('事务更新');
  });
  it('retrieves knowledge on explicit searches and paginates audits', () => {
    const { k, store } = fixture();
    const session = store.createSession();
    const doc = k.save({
      title: '库存事务规则',
      content: '库存扣减必须在数据库事务中执行。',
      kind: 'source',
    });
    store.message({
      id: 'previous',
      sessionId: session.id,
      role: 'user',
      content: '库存扣减需要注意什么？',
      createdAt: 1,
    });
    authorizeKnowledgeFixtures(k, doc);
    expect(k.search('库存事务', session.id)[0]).toMatchObject({ id: doc.id, excerpt: doc.content });
    for (let i = 0; i < 104; i++)
      k.save({
        title: '盘点资料' + i,
        content: '检查分页',
        kind: 'source',
        folderId: doc.folderId,
      });
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = k.audit(session.id, offset);
      ids.push(...page.documents.map((d) => d.id));
      offset = page.nextOffset;
    }
    expect(new Set(ids).size).toBe(105);
    const draft = k.save(
      { title: '核对目标', kind: 'wiki', content: '必须使用事务', sourceIds: [doc.id] },
      'agent',
    );
    const ready = k.review(draft.id, draft.version);
    expect(ready.status).toBe('ready');
    expect(ready.reviewedAt).toBeTruthy();
    expect(() => k.review(draft.id, draft.version)).toThrow('资料已更新');
  });
});
