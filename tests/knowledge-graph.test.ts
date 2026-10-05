import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/store';
import { Knowledge } from '../electron/knowledge';
import { assertionInput, buildKnowledgeGraph } from '../electron/knowledge-graph';
import type { KnowledgeAssertion } from '../src/shared/ontology';
import type { KnowledgeDocument, MemoryEntry } from '../src/shared/knowledge';
import { memoryEntryKey } from '../electron/knowledge-memory';
const clean: (() => void)[] = [];
afterEach(() =>
  clean
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-ontology-'));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'tongzhou.db'), { encrypt: (s) => s, decrypt: (s) => s });
  clean.push(() => store.close());
  return { store, k: new Knowledge(store, root) };
}
const assertion = (object = 'npm start'): KnowledgeAssertion => ({
  subject: '后台服务',
  subjectType: 'system',
  relation: 'command',
  object,
  quote: object,
});
describe('document-backed ontology', () => {
  it('validates relation targets, evidence, dates and saves versioned assertions', () => {
    const { k } = fixture();
    expect(() => assertionInput.parse({ ...assertion(), relation: 'depends_on' })).toThrow();
    expect(() => assertionInput.parse({ ...assertion(), objectType: 'system' })).toThrow();
    expect(() => assertionInput.parse({ ...assertion(), validFrom: '2026-02-30' })).toThrow();
    expect(() =>
      assertionInput.parse({ ...assertion(), validFrom: '2026-03-01', validUntil: '2026-02-01' }),
    ).toThrow();
    expect(() =>
      k.save({ title: 'bad', kind: 'wiki', content: 'no evidence', assertions: [assertion()] }),
    ).toThrow('原文一致');
    const d = k.save({
      title: '服务说明',
      kind: 'wiki',
      content: 'npm start',
      assertions: [assertion()],
    });
    expect(k.graph().facts[0].status).toBe('confirmed');
    k.save({ ...d, assertions: [], sourceIds: [] });
    expect(k.graph().facts).toHaveLength(0);
    k.restore(d.id, 1, 2);
    expect(k.graph().facts).toHaveLength(1);
  });
  it('retains conflicts, deduplicates evidence, and invalidates on source changes and deletion', () => {
    const { k } = fixture();
    const source = k.save({ title: '运行指南', kind: 'source', content: 'npm start\nnpm run dev' });
    const save = (value: string) =>
      k.save(
        {
          title: '整理',
          kind: 'wiki',
          content: value,
          status: 'draft',
          sourceIds: [source.id],
          assertions: [{ ...assertion(value), sourceId: source.id }],
        },
        'agent',
      );
    const a = save('npm start');
    save('npm start');
    save('npm run dev');
    let graph = k.graph();
    expect(graph.facts).toHaveLength(2);
    expect(graph.facts.every((f) => f.conflict)).toBe(true);
    expect(graph.facts.find((f) => f.object === 'npm start')!.evidence).toHaveLength(2);
    k.review(a.id, 1);
    expect(k.graph().facts.find((f) => f.object === 'npm start')!.status).toBe('confirmed');
    const changed = k.save({ ...source, content: 'npm start\nnpm run dev\nChanged' });
    expect(k.graph().facts.every((f) => f.status === 'stale')).toBe(true);
    k.delete(source.id, changed.version);
    expect(k.graph().facts.every((f) => f.status === 'stale')).toBe(true);
  });
  it('enforces tool scope and does not expand it through document links', async () => {
    const { k, store } = fixture();
    store.put('project', { id: 'private', name: 'private', path: '/private' });
    const s = store.createSession(),
      p = store.createSession('private');
    const secret = k.save({
      title: 'private',
      kind: 'wiki',
      projectId: 'private',
      content: 'npm start',
      assertions: [assertion()],
    });
    k.save({ title: 'public', kind: 'source', content: `[[${secret.id}|private]]` });
    expect(k.graph('', undefined, s.id).facts).toHaveLength(0);
    expect(k.graph('', undefined, p.id).facts).toHaveLength(1);
    const handlers = new Map();
    k.attach(
      { add: (spec: any, _name: any, fn: any) => handlers.set(spec.name, fn) } as any,
      s.id,
      true,
      () => {},
    );
    expect(
      JSON.parse((await handlers.get('knowledge_graph')({ query: '' })).text).facts,
    ).toHaveLength(0);
    expect(handlers.has('knowledge_write')).toBe(false);
  });
  it('groups cross-date memories, preserves per-entry scopes and allows reviewed correction/removal', () => {
    const { k, store } = fixture();
    const s = store.createSession(),
      other = store.createSession();
    const entry: MemoryEntry = {
      id: randomUUID(),
      category: 'preference',
      subject: '用户',
      relation: '偏好',
      content: '简短回答',
      sources: [],
      sessionId: s.id,
      occurredAt: 1,
    };
    const day = (date: string, entries: MemoryEntry[]) =>
      k.persist({
        id: randomUUID(),
        kind: 'memory',
        title: date,
        status: 'draft',
        origin: 'automatic',
        content: '记忆',
        tags: [],
        sources: [],
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        memoryDate: date,
        memoryEntries: entries,
      });
    const d = day('2026-10-01', [
      entry,
      { ...entry, id: randomUUID(), sessionId: other.id, content: '保密内容' },
    ]);
    day('2026-10-02', [{ ...entry, id: randomUUID(), reviewedAt: 2 }]);
    const graph = k.graph('', undefined, s.id);
    expect(graph.facts).toHaveLength(1);
    expect(graph.facts[0].evidence).toHaveLength(2);
    expect(graph.facts[0].status).toBe('confirmed');
    const edited = k.editMemory(d.id, d.version, entry.id, '详细回答');
    expect(edited.forgottenMemoryKeys).toContain(memoryEntryKey(entry));
    expect(() => k.editMemory(d.id, d.version, entry.id, null)).toThrow('已更新');
    const removed = k.editMemory(d.id, edited.version, entry.id, null);
    expect(removed.memoryEntries).toHaveLength(1);
    expect(k.graph('', undefined, s.id).facts[0].object).toBe('简短回答');
  });
  it('keeps entity IDs stable across case variants and paginates without loss', () => {
    const docs: KnowledgeDocument[] = Array.from({ length: 105 }, (_, i) => ({
      id: randomUUID(),
      kind: 'wiki',
      title: `${i}`,
      content: 'evidence',
      tags: [],
      sources: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      origin: 'manual',
      status: 'ready',
      assertions: [{ ...assertion(`value${i}`), subject: i % 2 ? 'API' : 'api', relation: 'fact' }],
    }));
    const a = buildKnowledgeGraph(docs, new Set()),
      b = buildKnowledgeGraph(docs, new Set(), '', a.nextOffset!);
    expect(a.total).toBe(105);
    expect(b.facts).toHaveLength(5);
    expect(new Set([...a.facts, ...b.facts].map((f) => f.id)).size).toBe(105);
    expect(a.entities).toHaveLength(1);
    expect(a.entities[0].id).toBe(b.entities[0].id);
  });
  it('uses validity intervals when finding conflicting single-value properties', () => {
    const { k } = fixture();
    k.save({
      title: '旧',
      kind: 'wiki',
      content: 'npm start',
      assertions: [{ ...assertion(), validUntil: '2020-01-01' }],
    });
    k.save({
      title: '新',
      kind: 'wiki',
      content: 'npm run dev',
      assertions: [{ ...assertion('npm run dev'), validFrom: '2021-01-01' }],
    });
    expect(k.graph().facts.some((f) => f.conflict)).toBe(false);
    expect(k.graph().facts.find((f) => f.object === 'npm start')!.status).toBe('expired');
  });
  it('resolves bidirectional document links and flags ambiguous titles', () => {
    const { k } = fixture();
    const a = k.save({ title: '部署', kind: 'source', content: '说明' });
    const b = k.save({ title: '入口', kind: 'source', content: `[[${a.id}|部署]]\n[[部署]]` });
    expect(k.read(b.id).links.every((l) => l.id === a.id)).toBe(true);
    expect(k.read(a.id).backlinks[0].id).toBe(b.id);
    k.save({ title: '部署', kind: 'source', content: '同名' });
    expect(k.read(b.id).links.find((l) => l.target === '部署')!.ambiguous).toBe(true);
    const folder = k.saveFolder({ name: '运维' });
    const moved = k.moveWiki(a.id, folder.id, a.version);
    k.deleteFolder(folder.id, folder.version);
    expect(k.get(a.id).content).toBe(moved.content);
    expect(k.read(b.id).links[0].id).toBe(a.id);
  });
});
