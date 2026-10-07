import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../electron/services/storage/store';
import { Knowledge } from '../../electron/modules/knowledge/knowledge';
import { ContentWorkspace } from '../../electron/modules/content/content';
import { ClientCommands } from '../../electron/core/tools/client-commands';
import { ToolScope } from '../../electron/core/tools/extensions';
import { registerContentServices } from '../../electron/modules/content/content-services';
import { registerKnowledgeServices } from '../../electron/modules/knowledge/knowledge-services';
vi.mock('electron', () => ({ dialog: {}, shell: {} }));
const clean: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-client-workspace-'));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'tongzhou.db');
  const crypto = { encrypt: (s: string) => s, decrypt: (s: string) => s };
  const store = new Store(database, crypto);
  clean.push(() => store.close());
  const knowledge = new Knowledge(store, root),
    content = new ContentWorkspace(store, knowledge);
  const session = store.createSession();
  const commands = new ClientCommands();
  const runtime = {
    store,
    knowledge,
    content,
    changed: vi.fn(),
    automations: { event: vi.fn() },
  } as any;
  const register = commands.register.bind(commands);
  registerContentServices(register, store, runtime);
  registerKnowledgeServices(register, store, runtime);
  const attach = (readonly = false, current = session.id, allow = true) => {
    const ask = vi.fn(async (_title: string, _detail: string, _force?: boolean) => allow);
    const scope = new ToolScope(new AbortController().signal, ask, () => {});
    clean.push(() => scope.close());
    commands.attach(scope, readonly, () => true, current);
    content.attach(scope, current, readonly, () => {});
    const call = async (tool: string, args: any) => {
      const result = await scope.call(tool, args);
      if (result.isError) throw new Error(result.text);
      return JSON.parse(result.text!);
    };
    return { scope, ask, call };
  };
  return { root, database, crypto, store, knowledge, content, session, commands, attach };
}
it('discovers contentWrite, saves to a specified nested directory and reads the committed text after reopening storage', async () => {
  const f = fixture(),
    { call, ask } = f.attach();
  const catalog = await call('client_catalog', { method: 'contentWrite' });
  expect(catalog.methods[0]).toMatchObject({
    access: 'change',
    available: true,
    confirmation: 'none',
  });
  const folder = await call('client_change', {
    method: 'knowledgeFolderSave',
    args: [{ name: '目标目录' }],
  });
  const child = await call('client_change', {
    method: 'knowledgeFolderSave',
    args: [{ name: '正文', parentId: folder.id }],
  });
  const input = {
    libraryId: 'default',
    folderId: child.id,
    title: '真实保存',
    content: '# 正文\n\n完整内容。',
  };
  const saved = await call('client_change', {
    method: 'contentWrite',
    argsJson: JSON.stringify([input]),
  });
  expect(saved).toMatchObject({
    persisted: true,
    totalChars: input.content.length,
    folderId: child.id,
    origin: 'agent',
  });
  expect((await call('content_read', { id: saved.id })).content).toBe(input.content);
  expect(
    (await call('client_query', { method: 'contentState', args: ['default'] })).documents[0].id,
  ).toBe(saved.id);
  expect(ask).not.toHaveBeenCalled();
  const reopened = new Store(f.database, f.crypto);
  try {
    expect(reopened.get<any>('knowledge', saved.id)).toMatchObject(input);
  } finally {
    reopened.close();
  }
  await expect(
    call('content_write', { ...input, id: '00000000-0000-0000-0000-000000000000', version: 1 }),
  ).rejects.toThrow('新建请省略');
  expect(f.knowledge.all()).toHaveLength(1);
});
it('imports and exports explicit absolute paths without a file picker', async () => {
  const f = fixture(),
    { call } = f.attach();
  const file = path.join(f.root, '原文.md');
  writeFileSync(file, '完整正文。');
  const imported = await call('client_change', {
    method: 'contentImport',
    args: ['default', null, [file]],
  });
  expect(imported.errors).toEqual([]);
  expect(imported.imported[0].content).toBe('完整正文。');
  const target = path.join(f.root, '导出目录', '正文.md');
  const receipt = await call('client_change', {
    method: 'contentExport',
    args: [imported.imported[0].id, target],
  });
  expect(receipt.persisted).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('完整正文。');
  await expect(
    call('client_change', { method: 'contentExport', args: [imported.imported[0].id, target] }),
  ).rejects.toThrow('EEXIST');
  await expect(
    call('client_change', { method: 'contentImport', args: ['default', null, ['relative.md']] }),
  ).rejects.toThrow('绝对路径');
});
it('edits personalization and rejects stale versions through chat', async () => {
  const f = fixture(),
    { call } = f.attach();
  const state = await call('client_query', { method: 'personalizationState' });
  const next = { ...state.profile, userPreferences: '回答简洁，使用中文。' };
  await call('client_change', { method: 'savePersonalization', args: [next] });
  expect(
    (await call('client_query', { method: 'personalizationState' })).profile.userPreferences,
  ).toBe(next.userPreferences);
  await expect(
    call('client_change', { method: 'savePersonalization', args: [next] }),
  ).rejects.toThrow();
});
it('requires explicit confirmation for deletion, leaves denied data intact and still supports direct additions', async () => {
  const f = fixture(),
    { call, ask } = f.attach(false, f.session.id, false);
  const doc = await call('client_change', {
    method: 'contentWrite',
    args: [{ libraryId: 'default', title: '保留', content: '内容' }],
  });
  expect(ask).not.toHaveBeenCalled();
  await expect(
    call('client_change', { method: 'knowledgeDelete', args: [doc.id, doc.version] }),
  ).rejects.toThrow('未批准');
  expect(ask.mock.calls[0][2]).toBe(true);
  expect(f.knowledge.get(doc.id).content).toBe('内容');
  const allowed = f.attach();
  await allowed.call('client_change', { method: 'knowledgeDelete', args: [doc.id, doc.version] });
  expect(f.knowledge.all()).toHaveLength(0);
});
it('publishes truthful read-only and background availability instead of bypassing scope', async () => {
  const f = fixture();
  const readonly = f.attach(true);
  expect(
    (await readonly.call('client_catalog', { method: 'contentWrite' })).methods[0].available,
  ).toBe(false);
  expect(readonly.scope.specs.map((s) => s.name)).not.toContain('client_change');
  const job = f.store.createSession();
  f.store.put('session', { ...job, automationJob: true });
  const background = f.attach(false, job.id);
  expect(
    (await background.call('client_catalog', { method: 'personalizationState' })).methods[0]
      .available,
  ).toBe(false);
  await expect(background.call('client_query', { method: 'personalizationState' })).rejects.toThrow(
    '后台',
  );
  await expect(
    background.call('client_change', {
      method: 'contentWrite',
      args: [{ libraryId: 'default', title: '不可越界', content: '' }],
    }),
  ).rejects.toThrow('后台');
});
