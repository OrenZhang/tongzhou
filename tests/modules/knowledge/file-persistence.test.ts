import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Knowledge } from '../../../electron/modules/knowledge/knowledge';
import { Store } from '../../../electron/services/storage/store';
import {
  DataMaintenance,
  applyPendingRestore,
} from '../../../electron/services/storage/data-maintenance';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tz-files-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanup.push(() => store.close());
  return { root, store, knowledge: new Knowledge(store, root) };
}
const input = {
  kind: 'wiki' as const,
  title: '文件保存测试',
  content: '第一版正文',
  tags: [],
  sourceIds: [],
};

describe('filesystem is the document source of truth', () => {
  it('acknowledges committed saves even when the derived navigation cannot be written', () => {
    const { knowledge: k, store } = fixture();
    vi.spyOn(k as any, 'writeIndex').mockImplementation(() => {
      throw new Error('index unavailable');
    });
    const first = k.save(input);
    const second = k.save({ ...first, content: '第二版正文' });
    expect(k.all()).toHaveLength(1);
    expect(k.get(first.id).content).toBe('第二版正文');
    expect(k.restore(first.id, 1, second.version).content).toBe(input.content);
    expect(store.list('knowledge')).toEqual([]);
    expect(store.list('knowledgeRevision')).toEqual([]);
    expect(
      store.db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_search'").get(),
    ).toBeUndefined();
  });
  it('keeps the previous version when replacing the document fails, and permits a clean retry', () => {
    const { knowledge: k } = fixture();
    const old = k.save(input);
    const fail = vi.spyOn(k.documents, 'put').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => k.save({ ...old, content: 'new' })).toThrow('disk full');
    expect(k.get(old.id)).toEqual(old);
    fail.mockRestore();
    expect(k.save({ ...old, content: 'new' }).version).toBe(2);
    expect(k.all()).toHaveLength(1);
  });
  it('reads local edits without a database index, including after restart', () => {
    const { knowledge: k, store, root } = fixture();
    const doc = k.save(input);
    const file = k.documents.file(doc.id);
    writeFileSync(file, readFileSync(file, 'utf8').replace(input.content, '外部编辑的真实正文'));
    const restarted = new Knowledge(store, root);
    expect(restarted.get(doc.id).content).toBe('外部编辑的真实正文');
    expect(restarted.search('真实正文')[0].id).toBe(doc.id);
  });
  it('backs up and restores documents and revision history solely from current local files', () => {
    const f = fixture();
    const old = f.knowledge.save(input);
    const updated = f.knowledge.save({ ...old, content: '备份前的最新正文' });
    const k = new Knowledge(f.store, f.root);
    expect(k.get(old.id)).toEqual(updated);
    expect(k.read(old.id).revisions).toHaveLength(1);
    const backup = new DataMaintenance(f.store, f.root).backup('test-password-123');
    const target = path.join(f.root, 'restored');
    mkdirSync(target);
    new DataMaintenance(f.store, target).prepareRestore(backup, 'test-password-123');
    applyPendingRestore(target);
    const restored = new Store(path.join(target, 'tongzhou.db'), {
      encrypt: (v) => v,
      decrypt: (v) => v,
    });
    cleanup.push(() => restored.close());
    expect(restored.list('knowledge')).toEqual([]);
    const restoredKnowledge = new Knowledge(restored, target);
    expect(restoredKnowledge.get(old.id)).toEqual(updated);
    expect(restoredKnowledge.restore(old.id, 1, updated.version).content).toBe(old.content);
  });
});
