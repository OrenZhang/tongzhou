import { authorizeKnowledgeFixtures } from '../../support/knowledge-fixture';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { Knowledge } from '../../../electron/modules/knowledge/knowledge';
import { ContentWorkspace } from '../../../electron/modules/content/content';
import { ToolScope } from '../../../electron/core/tools/extensions';
import { ClientCommands } from '../../../electron/core/tools/client-commands';
import { registerContentServices } from '../../../electron/modules/content/content-services';
vi.mock('electron', () => ({ dialog: {}, shell: {} }));
import type { Session } from '../../../src/shared/types';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-content-'));
  cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  cleanup.push(() => store.close());
  const knowledge = new Knowledge(store, root),
    content = new ContentWorkspace(store, knowledge);
  const library = content.saveLibrary({ name: '测试内容' });
  const document = content.write({ libraryId: library.id, title: '文稿', content: '甲乙丙丁' });
  authorizeKnowledgeFixtures(knowledge, document);
  const session = store.createSession();
  store.put('session', {
    ...session,
    knowledgeJob: true,
    contentContext: { documentId: document.id, libraryId: library.id },
  });
  const tools = (readOnly = false) => {
    const ask = vi.fn(async () => true);
    const scope = new ToolScope(new AbortController().signal, ask, () => {});
    cleanup.push(() => scope.close());
    content.attach(scope, session.id, readOnly, () => {});
    return { scope, ask };
  };
  return { root, store, knowledge, content, library, document, session, tools };
}
describe('generic content workspace', () => {
  it('starts scoped collaboration for supported image originals while retaining the unsupported-file boundary', async () => {
    const f = fixture();
    const image = f.knowledge.importFile(
      '人物.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
        'base64',
      ),
      undefined,
      f.library.id,
    );
    const start = vi.fn(() => 'test-run');
    const handlers = new Map<string, Function>();
    registerContentServices((name, _op, fn) => handlers.set(name, fn), f.store, {
      content: f.content,
      knowledge: f.knowledge,
      start,
    } as any);
    const run = handlers.get('contentRun')!;
    const input = {
      documentId: image.id,
      version: image.version,
      providerId: 'image-model',
      model: 'test',
      prompt: '根据这张图补充资产设定',
    };
    const result = run(input);
    expect(start).toHaveBeenCalledOnce();
    expect(f.store.get<Session>('session', result.sessionId).contentContext).toEqual({
      documentId: image.id,
      libraryId: f.library.id,
    });
    const pdf = f.knowledge.importFile(
      '尚未解析.pdf',
      Buffer.from('%PDF-test'),
      undefined,
      f.library.id,
    );
    expect(() => run({ ...input, documentId: pdf.id, version: pdf.version })).toThrow('尚未提取');
    expect(start).toHaveBeenCalledOnce();
  });
  it('reads actual library images on demand, keeps text reads unchanged and enforces scope and integrity', async () => {
    const f = fixture();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
      'base64',
    );
    const image = f.knowledge.importFile('林舟冬装.png', png, undefined, f.library.id);
    const { scope } = f.tools(true);
    const text = await scope.call('content_read', { id: image.id });
    expect(text.images).toBeUndefined();
    expect(JSON.parse(text.text!).content).toBe(image.content);
    const viewed = await scope.call('content_read', { id: image.id, includeImage: true });
    expect(viewed.images).toEqual([{ mimeType: 'image/png', data: png.toString('base64') }]);
    expect(JSON.parse(viewed.text!).media.imageIncluded).toBe(true);
    const outside = f.knowledge.importFile('其他库.png', png);
    expect((await scope.call('content_read', { id: outside.id, includeImage: true })).isError).toBe(
      true,
    );
    expect(() => f.content.preview(outside.id, f.session.id)).toThrow('范围');
    const oversized = f.knowledge.importFile(
      '大图.png',
      Buffer.concat([png, Buffer.alloc(3_000_000)]),
      undefined,
      f.library.id,
    );
    const metadata = await scope.call('content_read', { id: oversized.id, includeImage: true });
    expect(metadata.images).toBeUndefined();
    expect(JSON.parse(metadata.text!).media).toEqual({ type: 'file', imageIncluded: false });
    const fake = f.knowledge.importFile(
      '伪图.png',
      Buffer.from('并不是图片'),
      undefined,
      f.library.id,
    );
    expect((await scope.call('content_read', { id: fake.id, includeImage: true })).isError).toBe(
      true,
    );
    writeFileSync(path.join(f.knowledge.root, 'files', image.blob!), 'changed');
    expect((await scope.call('content_read', { id: image.id, includeImage: true })).isError).toBe(
      true,
    );
    expect(() => f.knowledge.originalBytes(image.id)).toThrow('校验');
  });
  it('reuses asset records across episodes with versioned sources and detects changes without replacing adopted references', async () => {
    const f = fixture(),
      { scope } = f.tools();
    const call = async (tool: string, args: unknown) => {
      const result = await scope.call(tool, args);
      expect(result.isError, result.text).toBeFalsy();
      return JSON.parse(result.text!);
    };
    const folder = await call('content_folder', {
      libraryId: f.library.id,
      name: '测试作品 · 公共人物',
    });
    const asset = await call('content_write', {
      libraryId: f.library.id,
      folderId: folder.id,
      contentType: 'manju/character',
      title: '测试作品 · 林舟',
      content: '@林舟\n当前采用：冬装；用户已确认。',
      sourceIds: [f.document.id],
    });
    const manifest = await call('content_write', {
      libraryId: f.library.id,
      title: '第01集 · 资产清单',
      content: `EP01_B001：@林舟 [[${asset.id}|人物设定]] v1，冬装。`,
      sourceIds: [asset.id],
    });
    expect(
      (await call('content_list', { query: '林舟' })).documents.map((d: any) => d.id),
    ).toContain(asset.id);
    await call('content_write', {
      id: asset.id,
      version: asset.version,
      libraryId: f.library.id,
      title: asset.title,
      content: '@林舟\n当前采用：冬装；夏装是新候选，尚未采用。',
    });
    const read = f.knowledge.read(manifest.id);
    expect(read.document.sources).toEqual([{ id: asset.id, title: asset.title, version: 1 }]);
    expect(read.changedSourceIds).toEqual([asset.id]);
    expect(read.links).toMatchObject([{ id: asset.id, ambiguous: false }]);
    expect(f.knowledge.read(asset.id).backlinks.map((d) => d.id)).toContain(manifest.id);
    const reopened = new ContentWorkspace(f.store, new Knowledge(f.store, f.root));
    expect(reopened.document(manifest.id).content).toBe(read.document.content);
    const stale = await scope.call('content_write', {
      id: asset.id,
      version: 1,
      libraryId: f.library.id,
      title: asset.title,
      content: '覆盖',
    });
    expect(stale.isError).toBe(true);
  });
  it('reads and updates files in directories, descendants and unfiled content', async () => {
    const f = fixture();
    const root = f.knowledge.saveFolder({ name: '根目录', libraryId: f.library.id });
    const child = f.knowledge.saveFolder({
      name: '子目录',
      libraryId: f.library.id,
      parentId: root.id,
    });
    const doc = f.content.write({
      libraryId: f.library.id,
      folderId: child.id,
      title: '可用内容',
      content: '正文',
    });
    const { scope } = f.tools();
    expect(f.knowledge.get(doc.id)).toEqual(doc);
    expect((await scope.call('content_read', { id: doc.id })).isError).toBeFalsy();
    expect(
      (
        await scope.call('content_write', {
          libraryId: f.library.id,
          id: doc.id,
          version: doc.version,
          title: doc.title,
          content: '更新正文',
        })
      ).isError,
    ).toBeFalsy();
    const listing = JSON.parse(
      (await scope.call('content_list', { libraryId: f.library.id })).text!,
    );
    expect(listing.documents.some((d: any) => d.id === doc.id)).toBe(true);
    expect(listing.folders.find((d: any) => d.id === child.id)).not.toHaveProperty('usageEnabled');
    const unfiled = f.knowledge.moveWiki(doc.id, null, f.knowledge.get(doc.id).version);
    expect(f.knowledge.get(doc.id)).toEqual(unfiled);
    expect((await scope.call('content_read', { id: doc.id })).isError).toBeFalsy();
    expect(new Knowledge(f.store, f.root).get(doc.id)).toEqual(unfiled);
    f.knowledge.bind(f.session.id, [doc.id]);
    expect(f.knowledge.search('更新正文', f.session.id).some((d) => d.id === doc.id)).toBe(true);
    f.knowledge.documents.remove(doc.id);
    expect((await scope.call('content_read', { id: doc.id })).isError).toBe(true);
  });
  it('removes the directory permission API from client discovery', () => {
    const f = fixture();
    const commands = new ClientCommands();
    registerContentServices((...args) => commands.register(...args), f.store, {
      content: f.content,
      knowledge: f.knowledge,
    } as any);
    expect(commands.describe({ method: 'contentFolderUsage' }).methods).toEqual([]);
  });
  it('isolates library folders and retains old documents in the default library', () => {
    const f = fixture();
    const old = f.knowledge.save({ title: '旧文档', content: '旧正文', kind: 'source' });
    const folder = f.knowledge.saveFolder({ name: '文章', libraryId: f.library.id });
    f.knowledge.saveFolder({ name: '文章' });
    expect(f.content.state(f.library.id).documents.map((d) => d.id)).toEqual([f.document.id]);
    expect(f.content.state('default').documents.map((d) => d.id)).toEqual([old.id]);
    expect(() => f.knowledge.moveWiki(old.id, folder.id, old.version)).toThrow('不属于');
    expect(() => f.knowledge.saveFolder({ name: '错误目录', parentId: folder.id })).toThrow(
      '不属于',
    );
    expect(() => f.content.deleteLibrary(f.library.id, f.library.version)).toThrow('文档和目录');
    expect(() => f.content.deleteLibrary('default', 1)).toThrow('不能删除');
    const renamed = f.content.saveLibrary({ ...f.library, name: '资料' });
    expect(() => f.content.saveLibrary({ ...f.library, name: '旧版本' })).toThrow('已更新');
    expect(renamed.version).toBe(2);
  });
  it('creates editable documents, preserves imported originals, and rejects stale edits', () => {
    const f = fixture();
    const original = f.knowledge.importFile(
      '原件.txt',
      Buffer.from('原始内容'),
      undefined,
      f.library.id,
    );
    expect(() =>
      f.content.write({
        id: original.id,
        version: original.version,
        libraryId: f.library.id,
        title: '新',
        content: '改动',
      }),
    ).toThrow('另存');
    const copy = f.content.write({
      libraryId: f.library.id,
      title: '可编辑副本',
      content: original.content,
      sourceIds: [original.id],
    });
    const next = f.content.write({
      id: copy.id,
      version: copy.version,
      libraryId: f.library.id,
      title: copy.title,
      content: '编辑后的内容',
    });
    expect(next.sources).toEqual([{ id: original.id, title: original.title, version: 1 }]);
    expect(f.knowledge.read(next.id).revisions).toHaveLength(1);
    expect(() =>
      f.content.write({
        id: copy.id,
        version: copy.version,
        libraryId: f.library.id,
        title: copy.title,
        content: '过期更新',
      }),
    ).toThrow('已被更新');
    expect(f.knowledge.restore(next.id, 1, next.version).content).toBe('原始内容');
  });
  it('splits losslessly, records source versions, and resumes identical requests without duplicates', () => {
    const f = fixture();
    const input = {
      sourceId: f.document.id,
      version: 1,
      mode: 'split',
      parts: [
        { title: '片段一', start: 0, end: 2 },
        { title: '片段二', start: 2, end: 4 },
      ],
    };
    const parts = f.content.derive(input, f.session.id);
    expect(parts.map((p) => f.knowledge.get(p.id).content).join('')).toBe('甲乙丙丁');
    expect(
      parts.every((p) => p.sources[0].version === 1 && p.sources[0].id === f.document.id),
    ).toBe(true);
    expect(f.content.derive(input, f.session.id).map((p) => p.id)).toEqual(parts.map((p) => p.id));
    expect(f.knowledge.all()).toHaveLength(3);
    expect(() =>
      f.content.derive({ ...input, parts: [{ title: '缺口', start: 1, end: 4 }] }, f.session.id),
    ).toThrow('遗漏');
    expect(() =>
      f.content.derive({ ...input, parts: [{ title: '不完整', start: 0, end: 2 }] }, f.session.id),
    ).toThrow('未覆盖');
    expect(f.knowledge.all()).toHaveLength(3);
  });
  it('confines tools to the selected library and withholds all writes in read-only mode', async () => {
    const f = fixture();
    const other = f.content.write({
      libraryId: 'default',
      title: '其他库内容',
      content: '不要泄露',
    });
    const { scope, ask } = f.tools();
    expect((await scope.call('content_read', { id: other.id })).isError).toBe(true);
    expect((await scope.call('content_list', { libraryId: 'default' })).isError).toBe(true);
    expect(
      (await scope.call('content_write', { libraryId: 'default', title: '越界', content: '' }))
        .isError,
    ).toBe(true);
    expect(
      (
        await scope.call('content_patch', {
          id: f.document.id,
          version: 1,
          before: '乙',
          after: '修改',
        })
      ).isError,
    ).toBeFalsy();
    expect(f.knowledge.get(f.document.id).content).toBe('甲修改丙丁');
    expect(ask).not.toHaveBeenCalled();
    expect(
      (
        await scope.call('content_patch', {
          id: f.document.id,
          version: 1,
          before: '丙',
          after: '覆盖',
        })
      ).isError,
    ).toBe(true);
    const readOnly = f.tools(true).scope;
    expect(readOnly.specs.map((s) => s.name)).toEqual(['content_list', 'content_read']);
    expect(f.knowledge.accessible(other, f.session.id)).toBe(false);
  });
  it('resumes a partially persisted batch without duplicating completed parts', () => {
    const f = fixture();
    const input = {
      sourceId: f.document.id,
      version: 1,
      mode: 'split',
      parts: [
        { title: '一', start: 0, end: 2 },
        { title: '二', start: 2, end: 4 },
      ],
    };
    const save = f.knowledge.save.bind(f.knowledge);
    let calls = 0;
    const spy = vi.spyOn(f.knowledge, 'save').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('模拟写入中断');
      return save(...args);
    });
    expect(() => f.content.derive(input, f.session.id)).toThrow('写入中断');
    expect(f.knowledge.all()).toHaveLength(2);
    spy.mockRestore();
    const docs = f.content.derive(input, f.session.id);
    expect(f.knowledge.all()).toHaveLength(3);
    expect(docs.map((d) => d.derivation?.index)).toEqual([0, 1]);
    expect(new Set(docs.map((d) => d.derivation?.createdAt)).size).toBe(1);
  });
  it('does not turn content conversations into personal memories or give normal sessions private access', () => {
    const f = fixture();
    const privateDoc = f.knowledge.save(
      { title: '私有资料', content: '正文', kind: 'source' },
      'manual',
      { sessionId: 'another' },
    );
    const normal = f.store.createSession();
    expect(() => f.content.document(privateDoc.id, normal.id)).toThrow('不在当前');
    expect(
      f.knowledge.memory.enqueue({
        id: 'fiction-run',
        sessionId: f.session.id,
        status: 'completed',
      } as any),
    ).toBe(false);
    expect(f.store.get<Session>('session', f.session.id).knowledgeJob).toBe(true);
  });
});
