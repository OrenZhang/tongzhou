import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../../../electron/services/storage/store';
import { Artifacts } from '../../../electron/modules/artifacts/artifacts';
import { ToolScope, normalizeOutput } from '../../../electron/core/tools/extensions';
import {
  DataMaintenance,
  applyPendingRestore,
} from '../../../electron/services/storage/data-maintenance';
import { sessionWorkspace } from '../../../electron/modules/sessions/session-workspace';
import { artifactDateRange, artifactDay } from '../../../src/shared/artifacts';
import { Knowledge } from '../../../electron/modules/knowledge/knowledge';
import { ContentWorkspace } from '../../../electron/modules/content/content';
import { registerArtifactServices } from '../../../electron/modules/artifacts/artifact-services';
vi.mock('electron', () => ({ dialog: {}, shell: {} }));

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=';
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-artifacts-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'tongzhou.db'), { encrypt: (s) => s, decrypt: (s) => s });
  cleanup.push(() => store.close());
  const session = store.createSession();
  const run = {
    id: randomUUID(),
    sessionId: session.id,
    model: 'test-model',
    startedAt: Date.now() - 1000,
  };
  store.put('run', run);
  const artifacts = new Artifacts(store, root),
    origin = { sessionId: session.id, runId: run.id };
  const workspace = sessionWorkspace(store, root, session.id);
  mkdirSync(workspace, { recursive: true });
  const scope = (sessionId = session.id) => {
    const ask = vi.fn(async () => true);
    const s = new ToolScope(new AbortController().signal, ask, () => {});
    artifacts.attach(s, { ...origin, sessionId }, () => {});
    cleanup.push(() => s.close());
    return { s, ask };
  };
  return { root, store, session, run, artifacts, origin, workspace, scope };
}
describe('generated artifacts', () => {
  it('filters exact local calendar-day boundaries without dropping other dates', async () => {
    const f = fixture(),
      one = await f.artifacts.save({ name: 'first.md', text: 'one' }, f.origin),
      two = await f.artifacts.save({ name: 'second.md', text: 'two' }, f.origin);
    const range = artifactDateRange('2026-10-07');
    f.store.put('artifact', {
      ...f.store.get<any>('artifact', one.id),
      createdAt: range.createdAfter!,
    });
    f.store.put('artifact', {
      ...f.store.get<any>('artifact', two.id),
      createdAt: range.createdBefore!,
    });
    expect(artifactDay(range.createdAfter!)).toBe('2026-10-07');
    expect(f.artifacts.list(range).items.map((a) => a.id)).toEqual([one.id]);
    expect(f.artifacts.list(artifactDateRange('2026-10-08')).items.map((a) => a.id)).toEqual([
      two.id,
    ]);
    expect(f.artifacts.list().total).toBe(2);
  });
  it('saves directly through workspace management and respects the chosen destination', async () => {
    const f = fixture(),
      a = await f.artifacts.save({ name: '文稿.md', text: '正文' }, f.origin);
    const knowledge = new Knowledge(f.store, f.root),
      content = new ContentWorkspace(f.store, knowledge);
    const handlers = new Map<string, Function>();
    const access = new Map<string, any>();
    registerArtifactServices(
      (name, op, fn) => {
        handlers.set(name, fn);
        access.set(name, op);
      },
      {
        artifacts: f.artifacts,
        content,
        store: f.store,
        knowledge,
        changed: vi.fn(),
        automations: { event: vi.fn() },
      } as any,
    );
    expect(access.get('artifactToKnowledge').access).toBe('change');
    const first = handlers.get('artifactToKnowledge')!(
      a.id,
      'default',
      undefined,
      '用户选择的目录',
    );
    const folder = knowledge.folders().find((d) => d.name === '用户选择的目录')!;
    expect(folder).not.toHaveProperty('usageEnabled');
    expect(knowledge.usable(knowledge.get(first))).toBe(true);
    expect(knowledge.get(first).folderId).toBe(folder.id);
    const existing = knowledge.saveFolder({ name: '已有目录' });
    const second = handlers.get('artifactToKnowledge')!(a.id, 'default', existing.id);
    expect(second).not.toBe(first);
    expect(knowledge.get(second).folderId).toBe(existing.id);
    expect(knowledge.get(first).folderId).toBe(folder.id);
    expect(handlers.get('artifactToKnowledge')!(a.id, 'default', existing.id)).toBe(second);
  });
  it('stores immutable independent copies, deduplicates deliveries and preserves the project original on delete', async () => {
    const f = fixture(),
      file = path.join(f.workspace, '报告.md');
    writeFileSync(file, '第一版');
    const a = await f.artifacts.save({ name: '报告.md', path: file }, f.origin);
    expect((await f.artifacts.save({ name: '报告.md', path: file }, f.origin)).id).toBe(a.id);
    writeFileSync(file, '第二版');
    expect(f.artifacts.preview(a.id).content).toBe('第一版');
    const b = await f.artifacts.save({ name: '报告.md', path: file }, f.origin);
    expect(b.id).not.toBe(a.id);
    expect(f.artifacts.list({ kind: 'document', query: '报告' }).total).toBe(2);
    expect(f.store.list('knowledge')).toHaveLength(0);
    f.artifacts.delete(a.id);
    expect(readFileSync(file, 'utf8')).toBe('第二版');
    expect(f.artifacts.read(b.id).model).toBe('test-model');
  });
  it('rejects paths outside the session, invalid images, ambiguous content and unsafe links', async () => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'outside.md'), 'private');
    await expect(
      f.artifacts.save({ name: 'outside.md', path: path.join(f.root, 'outside.md') }, f.origin),
    ).rejects.toThrow();
    await expect(
      f.artifacts.save({ name: 'fake.png', text: 'not a png' }, f.origin),
    ).rejects.toThrow('格式');
    await expect(
      f.artifacts.save({ name: 'both.md', text: 'x', url: 'https://example.com' }, f.origin),
    ).rejects.toThrow('只能');
    await expect(
      f.artifacts.save({ name: 'bad.md', url: 'file:///tmp/file' }, f.origin),
    ).rejects.toThrow('HTTPS');
    await expect(
      f.artifacts.save({ name: 'bad.md', url: 'https://user:pass@example.com/x' }, f.origin),
    ).rejects.toThrow('HTTPS');
    const a = await f.artifacts.save(
      { name: 'remote.pdf', url: 'https://example.invalid/test.pdf' },
      f.origin,
    );
    expect(f.artifacts.preview(a.id).type).toBe('external');
    expect(() => f.artifacts.bytes(a.id)).toThrow('外部链接');
  });
  it('isolates independent conversations and permits same project tools, requiring approval to materialize', async () => {
    const f = fixture(),
      a = await f.artifacts.save({ name: '图片.png', data: png }, f.origin),
      other = f.store.createSession();
    const { s } = f.scope(other.id);
    expect((await s.call('artifact_read', { id: a.id })).isError).toBe(true);
    expect(JSON.parse((await s.call('artifact_list', {})).text).items).toHaveLength(0);
    const own = f.scope();
    expect((await own.s.call('artifact_read', { id: a.id })).images?.[0].data).toBe(png);
    const copy = JSON.parse((await own.s.call('artifact_materialize', { id: a.id })).text);
    expect(own.ask).toHaveBeenCalled();
    expect(readFileSync(path.join(f.workspace, copy.path)).toString('base64')).toBe(png);
    const projectId = randomUUID();
    f.store.put('project', { id: projectId, path: f.workspace });
    f.store.put('session', { ...f.session, projectId });
    f.store.put('session', { ...other, projectId });
    const b = await f.artifacts.save({ name: '共享.md', text: '同项目作品' }, f.origin);
    expect(f.artifacts.accessible(b.id, other.id)).toBe(true);
    expect(f.artifacts.accessible(a.id, other.id)).toBe(false);
  });
  it('only collects newly written final file links, not old reference files or external links', async () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, 'old.pdf'), 'old');
    utimesSync(path.join(f.workspace, 'old.pdf'), 1, 1);
    writeFileSync(path.join(f.workspace, 'new.md'), 'new');
    const result = await f.artifacts.collectLinks(
      '[new](new.md) [old](old.pdf) [url](https://example.invalid/file.pdf)',
      f.origin,
    );
    expect(result.items.map((a) => a.name)).toEqual(['new.md']);
  });
  it('reports file corruption instead of serving altered bytes and retains works in encrypted backup/restore', async () => {
    const f = fixture(),
      a = await f.artifacts.save({ name: '保存.md', text: '备份内容' }, f.origin);
    const backup = new DataMaintenance(f.store, f.root).backup('long-backup-password');
    const target = path.join(f.root, 'restored');
    mkdirSync(target);
    new DataMaintenance(f.store, target).prepareRestore(backup, 'long-backup-password');
    applyPendingRestore(target);
    const restored = new Store(path.join(target, 'tongzhou.db'), {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    try {
      expect(new Artifacts(restored, target).preview(a.id).content).toBe('备份内容');
    } finally {
      restored.close();
    }
    const file = f.artifacts.openPath(a.id);
    writeFileSync(file, '篡改内容');
    expect(() => f.artifacts.bytes(a.id)).toThrow('校验');
    f.artifacts.delete(a.id);
    expect(existsSync(file)).toBe(false);
  });
  it('collects generated MCP images/resources while keeping read-only observations and failures out', async () => {
    const f = fixture(),
      image = { type: 'image', mimeType: 'image/png', data: png };
    expect(normalizeOutput({ content: [image] }).artifacts).toBeUndefined();
    expect(normalizeOutput({ isError: true, content: [image] }, true).artifacts).toBeUndefined();
    const output = normalizeOutput(
      {
        content: [
          image,
          {
            type: 'resource',
            resource: {
              uri: 'generated/report.md',
              mimeType: 'text/markdown',
              blob: Buffer.from('报告').toString('base64'),
            },
          },
        ],
      },
      true,
    );
    const result = await f.artifacts.collect(output.artifacts!, f.origin);
    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((a) => a.kind)).toEqual(['image', 'document']);
    expect(output.text).not.toContain(png);
    const explicit = normalizeOutput(
      { content: [image], structuredContent: { artifacts: [{ name: '指定名称.png', data: png }] } },
      true,
    );
    expect(explicit.artifacts?.map((a) => a.name)).toEqual(['指定名称.png']);
  });
  it('scoped artifact tools return deliverable IDs and do not accept local paths through create', async () => {
    const f = fixture(),
      { s } = f.scope();
    const output = await s.call('artifact_create', { name: 'result.md', text: '成果' });
    expect(output.isError).toBeFalsy();
    expect(output.artifactIds).toHaveLength(1);
    expect(
      (await s.call('artifact_create', { name: 'private.md', path: 'private.md' })).isError,
    ).toBe(true);
    expect(f.artifacts.list().total).toBe(1);
  });
});
