import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ dialog: {}, shell: {} }));
import { registerKnowledgeServices } from '../electron/knowledge-services';
import { ClientCommands } from '../electron/client-commands';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
  it('organizes nested Wiki folders without changing scope or losing pages when a directory is deleted', () => {
    const { k, store, root } = fixture();
    store.put('project', { id: 'private', name: 'Private', path: '/private' });
    const ordinary = store.createSession();
    const parent = k.saveFolder({ name: '研发' });
    const child = k.saveFolder({ name: '接口', parentId: parent.id });
    const source = k.importFile('原文.txt', Buffer.from('原始接口定义'));
    const wiki = k.save({
      title: '接口规则',
      kind: 'wiki',
      content: '接口规则正文',
      folderId: child.id,
      projectId: 'private',
      sourceIds: [source.id],
    });
    const unfiled = k.save({ title: '其他规则', kind: 'wiki', content: '其他', status: 'draft' });
    expect(k.state('', undefined, undefined, parent.id).documents.map((d) => d.id)).toEqual([
      wiki.id,
    ]);
    expect(k.state('', undefined, undefined, null).documents.map((d) => d.id)).toEqual([
      unfiled.id,
    ]);
    expect(k.state('', undefined, undefined, '*').documents.map((d) => d.id)).toEqual(
      expect.arrayContaining([unfiled.id, wiki.id]),
    );
    expect(k.search('', ordinary.id).some((d) => d.id === wiki.id)).toBe(false);
    const renamed = k.saveFolder({ ...child, name: 'API', parentId: null });
    expect(k.get(wiki.id).folderId).toBe(child.id);
    expect(k.state('', undefined, undefined, parent.id).documents).toHaveLength(0);
    expect(() => k.saveFolder({ ...child, name: '过期改名' })).toThrow('目录已更新');
    const moved = k.moveWiki(wiki.id, parent.id, wiki.version);
    expect(moved).toMatchObject({
      content: wiki.content,
      sources: wiki.sources,
      projectId: 'private',
      status: 'ready',
    });
    expect(() => k.moveWiki(wiki.id, null, wiki.version)).toThrow('知识页已更新');
    expect(k.search('', ordinary.id).some((d) => d.id === wiki.id)).toBe(false);
    k.saveFolder({ ...renamed, parentId: parent.id });
    k.deleteFolder(parent.id, parent.version);
    expect(k.folders()).toHaveLength(0);
    const retained = k.get(wiki.id);
    expect(retained.folderId).toBeUndefined();
    expect(retained.content).toBe(wiki.content);
    expect(retained.sources).toEqual(wiki.sources);
    expect(k.restore(wiki.id, 1, retained.version).folderId).toBeUndefined();
    expect(new Knowledge(store, root).get(wiki.id).content).toBe(wiki.content);
    expect(existsSync(path.join(k.root, 'wiki', `${wiki.id}.md`))).toBe(true);
  });
  it('rejects invalid directory trees and folder assignments', () => {
    const { k } = fixture();
    const parent = k.saveFolder({ name: 'Root' });
    const child = k.saveFolder({ name: 'Child', parentId: parent.id });
    expect(() => k.saveFolder({ name: 'root' })).toThrow('已有这个名称');
    expect(() => k.saveFolder({ name: '../invalid' })).toThrow();
    expect(() => k.saveFolder({ ...parent, parentId: child.id })).toThrow('自身或子目录');
    let deepest = child;
    for (let i = 3; i <= 8; i++)
      deepest = k.saveFolder({ name: `Level ${i}`, parentId: deepest.id });
    expect(() => k.saveFolder({ name: 'too deep', parentId: deepest.id })).toThrow('8 层');
    const outer = k.saveFolder({ name: 'Outer' });
    expect(() => k.saveFolder({ ...parent, parentId: outer.id })).toThrow('8 层');
    expect(() =>
      k.save({ title: '原文', kind: 'source', content: '原文', folderId: parent.id }),
    ).toThrow('只有 Wiki');
    const source = k.save({ title: '原文', kind: 'source', content: '原文' });
    expect(() => k.moveWiki(source.id, parent.id, source.version)).toThrow('只用于 Wiki');
    const changed = k.saveFolder({ ...outer, name: 'New outer' });
    expect(() => k.deleteFolder(changed.id, outer.version)).toThrow('目录已更新');
  });
  it('lets scoped knowledge tools discover folders and save a draft in them', async () => {
    const { k, store } = fixture();
    const session = store.createSession();
    const folder = k.saveFolder({ name: '模型知识' });
    const source = k.save({ title: '模型原文', content: '模型原文', kind: 'source' });
    const handlers = new Map<string, any>();
    k.attach(
      { add: (spec: any, _title: any, execute: any) => handlers.set(spec.name, execute) } as any,
      session.id,
      false,
      () => {},
    );
    expect(JSON.parse((await handlers.get('knowledge_folders')({})).text)[0].id).toBe(folder.id);
    const saved = JSON.parse(
      (
        await handlers.get('knowledge_write')({
          title: '模型说明',
          content: '模型说明',
          sourceIds: [source.id],
          folderId: folder.id,
        })
      ).text,
    );
    expect(saved).toMatchObject({ folderId: folder.id, status: 'draft', kind: 'wiki' });
    expect(k.save({ ...k.get(saved.id), content: '补充', sourceIds: [source.id] }).folderId).toBe(
      folder.id,
    );
  });
  it('prevents the client-management tool from marking its own work as human reviewed', async () => {
    const { k, store } = fixture();
    const session = store.createSession();
    const commands = new ClientCommands();
    registerKnowledgeServices(
      (name, definition, handler) => commands.register(name, definition, handler),
      store,
      { knowledge: k, changed: () => {} } as any,
    );
    const handlers = new Map<string, any>();
    commands.attach(
      { add: (spec: any, _title: any, execute: any) => handlers.set(spec.name, execute) } as any,
      false,
      () => true,
      session.id,
    );
    const change = handlers.get('client_change');
    await expect(
      change({
        method: 'knowledgeSave',
        args: [{ title: '自动确认', kind: 'wiki', content: '未核对', status: 'ready' }],
      }),
    ).rejects.toThrow('必须为 draft');
    const saved = JSON.parse(
      (
        await change({
          method: 'knowledgeSave',
          args: [{ title: '草稿', kind: 'wiki', content: '待核对', status: 'draft' }],
        })
      ).text,
    );
    await expect(
      change({ method: 'knowledgeReview', args: [saved.id, saved.version] }),
    ).rejects.toThrow('不可通过');
    expect(k.get(saved.id).status).toBe('draft');
  });
  it('directly deletes current versions, removes files and pins, and preserves dependent Wiki evidence', () => {
    const { k, root, store } = fixture();
    const session = store.createSession();
    store.put('session', { ...session, knowledgeJob: true });
    const source = k.importFile('原文.txt', Buffer.from('source evidence'));
    const wiki = k.save({
      title: '引用知识',
      content: 'source evidence',
      kind: 'wiki',
      sourceIds: [source.id],
    });
    k.bind(session.id, [source.id, wiki.id]);
    const changed = k.save({ ...source, title: '更新原文标题' });
    expect(() => k.delete(source.id, source.version)).toThrow('资料已更新');
    const files = [
      path.join(k.root, 'sources', `${source.id}.md`),
      path.join(k.root, 'files', source.blob!),
      path.join(k.root, 'revisions', `${source.id}-1.json`),
    ];
    expect(files.every(existsSync)).toBe(true);
    k.delete(source.id, changed.version);
    expect(() => k.get(source.id)).toThrow('已删除');
    expect(files.some(existsSync)).toBe(false);
    expect(store.list('knowledgeRevision')).toHaveLength(0);
    expect(k.pins(session.id)).toEqual([wiki.id]);
    expect(k.read(wiki.id).missingSourceIds).toEqual([source.id]);
    expect(k.state().issues.some((i) => i.id === wiki.id && i.reason.includes('来源已删除'))).toBe(
      true,
    );
    expect(k.search('source', session.id).some((d) => d.id === wiki.id)).toBe(true);
    k.bind(session.id, []);
    expect(k.pins(session.id)).toEqual([]);
    expect(k.save({ ...wiki, content: '补充核对说明', sourceIds: [source.id] }).sources[0].id).toBe(
      source.id,
    );
    expect(k.search('source').some((d) => d.id === source.id)).toBe(false);
    expect(readFileSync(path.join(root, 'knowledge/index.md'), 'utf8')).not.toContain(source.id);
    expect(
      store.db.prepare('SELECT id FROM knowledge_search WHERE id=?').get(source.id),
    ).toBeUndefined();
  });
  it('refuses a replaced vault folder before deleting any files', () => {
    const { k, root } = fixture();
    const source = k.importFile('原文.txt', Buffer.from('evidence'));
    const changed = k.save({ ...source, title: '更新标题' });
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    const revisions = path.join(k.root, 'revisions');
    rmSync(revisions, { recursive: true });
    symlinkSync(outside, revisions, 'junction');
    expect(() => k.delete(source.id, changed.version)).toThrow('符号链接');
    expect(existsSync(path.join(k.root, 'sources', `${source.id}.md`))).toBe(true);
    expect(existsSync(path.join(k.root, 'files', source.blob!))).toBe(true);
    expect(k.get(source.id).status).toBe('ready');
  });
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
    expect(k.search('接口')[0].id).toBe(source.id);
  });
  it('recovers legacy archives once and cannot restore an archived revision into a hidden state', () => {
    const { k, store, root } = fixture();
    const source = k.importFile('历史原文.txt', Buffer.from('历史原文'));
    const draft = k.save(
      { title: '历史草稿', content: '待核对', kind: 'wiki', status: 'draft' },
      'agent',
    );
    k.persist({ ...source, status: 'archived', archivedStatus: 'ready', version: 2 }, source);
    k.persist({ ...draft, status: 'archived', version: 2 }, draft);
    const migrated = new Knowledge(store, root);
    expect(migrated.get(source.id)).toMatchObject({
      status: 'ready',
      version: 3,
      blob: source.blob,
    });
    expect(migrated.get(draft.id)).toMatchObject({ status: 'draft', version: 3 });
    expect(migrated.state().documents.map((d) => d.id)).toEqual(
      expect.arrayContaining([source.id, draft.id]),
    );
    expect(migrated.search('历史原文')[0].id).toBe(source.id);
    expect(new Knowledge(store, root).get(source.id).version).toBe(3);
    expect(migrated.restore(source.id, 2, 3).status).toBe('ready');
    expect(migrated.restore(draft.id, 2, 3).status).toBe('draft');
    expect(() => migrated.save({ ...source, status: 'archived' })).toThrow();
    migrated.delete(draft.id, migrated.get(draft.id).version);
    expect(() => migrated.get(draft.id)).toThrow('已删除');
  });
  it('isolates projects and ordinary-session memories, and ignores legacy conversation pins', () => {
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
    expect(k.search('秘密实现', b.id)).toHaveLength(0);
    k.bind(b.id, [local.id]);
    expect(k.search('秘密实现', b.id)).toHaveLength(0);
    expect(k.pins(b.id)).toEqual([]);
    k.configure({ autoCollect: false });
    expect(k.search('共享', b.id).some((d) => d.id === global.id)).toBe(true);
    k.delete(local.id, local.version);
    expect(k.search('秘密实现', a.id)).toHaveLength(0);
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
    expect(k.all()).toHaveLength(0);
    expect(k.memory.candidates()).toHaveLength(1);
    expect(k.memory.claim()).toBeUndefined();
    const work = k.memory.claim(true)!;
    expect(work.prompt).not.toContain('topsecret');
    expect(work.prompt).not.toContain('abcd1234');
    k.memory.commit(work.job.id, {
      entries: [
        {
          category: 'todo',
          subject: '库存',
          relation: '待验证',
          content: '尚未验证库存',
          evidence: [{ candidateId: 'r', quote: '尚未验证库存' }],
        },
      ],
    });
    const memory = k.all()[0];
    expect(memory.status).toBe('draft');
    expect(memory.sources[0].messageId).toBe('m');
    expect(memory.content).not.toContain('topsecret');
    expect(memory.content).not.toContain('abcd1234');
    expect(memory.content).toContain('尚未验证');
    expect(k.search('库存', session.id)[0].status).toBe('draft');
    k.delete(memory.id, memory.version);
    k.capture(run);
    expect(k.all()).toHaveLength(0);
    k.configure({ autoCollect: false });
    k.capture({ ...run, id: 'another' });
    expect(k.all()).toHaveLength(0);
  });
  it('enforces agent write scope and protects manual knowledge from automatic replacement', async () => {
    const { store, k } = fixture();
    const session = store.createSession();
    const source = k.save({ title: '原文', content: '版本是 1', kind: 'source' });
    k.configure({ autoCollect: false });
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
    const folder = k.saveFolder({ name: '参考目录' });
    const wiki = k.save({
      title: '参考 Wiki',
      kind: 'wiki',
      content: 'persistent wiki',
      folderId: folder.id,
    });
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
    expect(
      JSON.parse(readFileSync(path.join(target, 'knowledge', 'folders.json'), 'utf8')),
    ).toEqual([folder]);
    const restoredStore = new Store(path.join(target, 'tongzhou.db'), {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    clean.push(() => restoredStore.close());
    const restored = new Knowledge(restoredStore, target);
    expect(restored.folders()).toEqual([folder]);
    expect(restored.get(wiki.id).folderId).toBe(folder.id);
  });
});
