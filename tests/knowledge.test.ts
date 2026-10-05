import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { Knowledge } from '../electron/knowledge';
import { DataMaintenance, applyPendingRestore } from '../electron/data-maintenance';
import type { Run } from '../src/shared/types';
const clean: (() => void)[] = [];
afterEach(() => {
  for (const fn of clean.splice(0).reverse()) fn();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-knowledge-'));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'tongzhou.db'), { encrypt: (s) => s, decrypt: (s) => s });
  clean.push(() => store.close());
  const k = new Knowledge(store, root);
  return { root, store, k };
}
describe('local knowledge lifecycle', () => {
  it('imports immutable originals, deduplicates by hash and indexes Chinese and English', () => {
    const { k, root } = fixture();
    const d = k.importFile(
      '参考.md',
      Buffer.from('# 库存规则\n订单库存每次扣减一件。Inventory is transactional.'),
    );
    expect(k.importFile('copy.md', Buffer.from(d.content)).id).toBe(d.id);
    expect(k.search('库存')[0].id).toBe(d.id);
    expect(k.search('transactional')[0].id).toBe(d.id);
    expect(k.read(d.id).outline).toEqual([{ title: '库存规则', line: 1, level: 1 }]);
    expect(readFileSync(path.join(root, 'knowledge', 'files', d.blob!), 'utf8')).toBe(d.content);
    expect(() => k.save({ ...d, content: 'changed' })).toThrow('原文');
    const pdf = k.importFile('report.pdf', Buffer.from('%PDF binary'));
    expect(pdf.indexed).toBe(false);
    expect(k.state().issues.some((i) => i.id === pdf.id && i.reason.includes('正文'))).toBe(true);
  });
  it('keeps revisions, rejects stale writes, marks changed sources and restores without losing history', () => {
    const { k } = fixture();
    const source = k.save({ title: '接口说明', content: 'v1', kind: 'source' });
    const wiki = k.save({
      title: '接入指南',
      content: '使用 v1',
      kind: 'wiki',
      sourceIds: [source.id],
    });
    const changed = k.save({ ...source, content: 'v2' });
    expect(() => k.save({ ...source, content: 'stale' })).toThrow('已被更新');
    expect(k.state().issues.find((i) => i.id === wiki.id)?.reason).toContain('来源已更新');
    expect(k.read(source.id).backlinks[0].id).toBe(wiki.id);
    expect(k.restore(source.id, 1, changed.version).content).toBe('v1');
    expect(k.read(source.id).revisions.map((r) => r.version)).toEqual([2, 1]);
    k.archive(source.id, true);
    expect(k.search('接口')).toHaveLength(0);
    expect(k.state().archived[0].id).toBe(source.id);
    k.archive(source.id, false);
    expect(k.search('接口')[0].id).toBe(source.id);
  });
  it('isolates projects and ordinary-session memories, and honors explicit references and archive', () => {
    const { k, store } = fixture();
    store.put('project', { id: 'a', name: 'A', path: '/a' });
    store.put('project', { id: 'b', name: 'B', path: '/b' });
    const a = store.createSession('a'),
      b = store.createSession('b'),
      ordinary = store.createSession(),
      other = store.createSession();
    const global = k.save({ title: '共享规范', content: '共享资料', kind: 'source' });
    const local = k.save({
      title: '项目资料',
      content: '秘密实现',
      kind: 'source',
      projectId: 'a',
    });
    const memory = k.save(
      { title: '会话记忆', content: '只用于此会话', kind: 'memory' },
      'automatic',
      { sessionId: ordinary.id },
    );
    expect(k.search('', a.id).map((d) => d.id)).toContain(local.id);
    expect(k.search('', b.id).map((d) => d.id)).not.toContain(local.id);
    expect(k.search('', other.id).map((d) => d.id)).not.toContain(memory.id);
    expect(k.search('', ordinary.id).map((d) => d.id)).toContain(memory.id);
    expect(k.context(b.id, '秘密实现')).not.toContain('秘密实现');
    k.bind(b.id, [local.id]);
    expect(k.context(b.id, 'Hello')).toContain('秘密实现');
    k.configure({ autoCollect: false, autoContext: false });
    expect(k.context(b.id, '共享')).not.toContain(global.id);
    k.archive(local.id, true);
    expect(k.context(b.id, 'Hello')).toBe('');
  });
  it('captures completed turns once, preserves sources and redacts obvious credential assignments', () => {
    const { store, k } = fixture();
    const session = store.createSession();
    store.message({
      id: 'm',
      sessionId: session.id,
      runId: 'r',
      role: 'user',
      content: 'password=topsecret API_KEY=abcd1234 库存验证',
      createdAt: 1,
    });
    store.message({
      id: 'a',
      sessionId: session.id,
      runId: 'r',
      role: 'assistant',
      content: '尚未验证库存',
      createdAt: 2,
    });
    const run = { id: 'r', sessionId: session.id, status: 'completed', startedAt: 1 } as Run;
    k.capture(run);
    k.capture(run);
    expect(k.all()).toHaveLength(1);
    const memory = k.all()[0];
    expect(memory.status).toBe('draft');
    expect(memory.sources[0].messageId).toBe('m');
    expect(memory.content).not.toContain('topsecret');
    expect(memory.content).not.toContain('abcd1234');
    expect(memory.content).toContain('尚未验证');
    expect(k.context(session.id, '库存')).toBe('');
    k.configure({ autoCollect: false, autoContext: true });
    k.capture({ ...run, id: 'another' });
    expect(k.all()).toHaveLength(1);
  });
  it('enforces agent write scope and protects manual knowledge from automatic replacement', async () => {
    const { store, k } = fixture();
    const session = store.createSession();
    const source = k.save({ title: '原文', content: '版本是 1', kind: 'source' });
    const handlers = new Map<string, any>();
    const scope = {
      add: (spec: any, _title: any, execute: any) => handlers.set(spec.name, execute),
    } as any;
    k.attach(scope, session.id, false, () => {});
    const result = JSON.parse(
      (
        await handlers.get('knowledge_write')({
          title: '整理结果',
          content: '版本 1',
          sourceIds: [source.id],
        })
      ).text,
    );
    const doc = k.get(result.id);
    expect(doc.status).toBe('draft');
    expect(doc.sources[0].version).toBe(1);
    k.save({ ...doc, status: 'ready', sourceIds: [source.id] });
    await expect(
      handlers.get('knowledge_write')({
        id: doc.id,
        version: 2,
        title: doc.title,
        content: 'replace',
        sourceIds: [source.id],
      }),
    ).rejects.toThrow('人工内容');
    const readonly = new Map<string, any>();
    k.attach(
      { add: (spec: any) => readonly.set(spec.name, true) } as any,
      session.id,
      true,
      () => {},
    );
    expect(readonly.has('knowledge_write')).toBe(false);
    store.message({
      id: 'new-fact',
      sessionId: session.id,
      role: 'user',
      content: '库存接口需要幂等键。',
      createdAt: 1,
    });
    const fresh = JSON.parse(
      (
        await handlers.get('knowledge_write')({
          title: '幂等规则',
          content: '用户要求库存接口支持幂等键。',
          sourceIds: [],
        })
      ).text,
    );
    const sourceOfFresh = k.get(k.get(fresh.id).sources[0].id);
    expect(sourceOfFresh.content).toContain('库存接口需要幂等键');
    expect(sourceOfFresh.sources[0].messageId).toBe('new-fact');
  });
  it('includes the knowledge files and index in encrypted backup and restores the vault', () => {
    const { root, store, k } = fixture();
    const d = k.importFile('guide.txt', Buffer.from('persistent knowledge'));
    const maintenance = new DataMaintenance(store, root);
    const bytes = maintenance.backup('long-backup-password');
    const target = mkdtempSync(path.join(tmpdir(), 'tongzhou-vault-restore-'));
    clean.push(() => rmSync(target, { recursive: true, force: true }));
    new DataMaintenance(store, target).prepareRestore(bytes, 'long-backup-password');
    applyPendingRestore(target);
    expect(readFileSync(path.join(target, 'knowledge', 'files', d.blob!), 'utf8')).toBe(
      'persistent knowledge',
    );
    expect(readFileSync(path.join(target, 'knowledge', 'index.md'), 'utf8')).toContain('guide.txt');
  });
});
