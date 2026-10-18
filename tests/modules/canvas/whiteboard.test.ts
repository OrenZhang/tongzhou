import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyWhiteboardOperations,
  whiteboardSceneSchema,
} from '../../../electron/modules/canvas/whiteboard';
import { emptyWhiteboard } from '../../../src/shared/whiteboard';
import { Store } from '../../../electron/services/storage/store';
import { createDomainServices } from '../../../electron/modules/domain-services';
import { ToolScope } from '../../../electron/core/tools/extensions';
import { attachCanvasTools } from '../../../electron/modules/canvas/canvas-tools';
import { mergeCanvasChanges } from '../../../src/shared/canvas-collaboration';
import type { Canvas } from '../../../src/shared/canvas';
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
const initialOps = [
  { type: 'add', element: { id: 'start', type: 'rectangle', x: 0, y: 0, text: '开始' } },
  { type: 'add', element: { id: 'end', type: 'diamond', x: 400, y: 0, text: '通过？' } },
  { type: 'connect', id: 'edge', from: 'start', to: 'end', text: '下一步' },
];
const initial = () => applyWhiteboardOperations(emptyWhiteboard(), initialOps).scene;
describe('editable whiteboards', () => {
  it('creates native bound text and arrows and updates only requested shapes', () => {
    const scene = initial();
    const next = applyWhiteboardOperations(scene, [
      { type: 'update', id: 'end', patch: { x: 500, text: '已登录？' } },
    ]).scene;
    const label = next.elements.find((e) => e.containerId === 'end')!;
    expect(label.text).toBe('已登录？');
    expect(label.x).toBe(510);
    expect(next.elements.find((e) => e.id === 'edge')!.endBinding.elementId).toBe('end');
    expect(next.elements.find((e) => e.id === 'start')).toEqual(
      scene.elements.find((e) => e.id === 'start'),
    );
    expect(scene.elements.find((e) => e.id === 'end')!.x).toBe(400);
    const renamed = applyWhiteboardOperations(scene, [{ type: 'rename', title: '新名字' }]);
    expect(renamed.scene.elements).toEqual(scene.elements);
  });
  it('deletes bound labels and detaches arrows, preserves images and rejects invalid batches atomically', () => {
    const scene = initial();
    const removed = applyWhiteboardOperations(scene, [{ type: 'remove', ids: ['end'] }]).scene;
    expect(
      removed.elements
        .filter((e) => e.id === 'end' || e.containerId === 'end')
        .every((e) => e.isDeleted),
    ).toBe(true);
    expect(removed.elements.find((e) => e.id === 'edge')!.endBinding).toBeNull();
    expect(() =>
      applyWhiteboardOperations(scene, [
        { type: 'update', id: 'start', patch: { x: 99 } },
        { type: 'remove', ids: ['missing'] },
      ]),
    ).toThrow('不存在');
    expect(scene.elements[0].x).toBe(0);
    expect(() =>
      applyWhiteboardOperations(scene, [
        { type: 'add', element: { id: 'bad', type: 'image', x: 0, y: 0, fileId: 'missing' } },
      ]),
    ).toThrow('图片文件不存在');
    expect(() =>
      whiteboardSceneSchema.parse({ ...scene, elements: [scene.elements[0], scene.elements[0]] }),
    ).toThrow('重复');
  });
  it('exposes AI tools, checks versions, keeps image bytes out of reads, and hides writes in read-only sessions', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cosail-whiteboard-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
    cleanup.push(() => store.close());
    const domains = createDomainServices(store, root),
      session = store.createSession();
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanup.push(() => scope.close());
    attachCanvasTools(
      scope,
      store,
      domains.canvases,
      domains.canvasWorkflows,
      session,
      false,
      () => {},
    );
    const result = await scope.call('whiteboard_create', { title: '登录流程', ops: initialOps });
    expect(result.isError, result.text).not.toBe(true);
    const created = JSON.parse(result.text!);
    const seeded = domains.canvases.get(created.canvasId);
    const { updatedAt: _, ...input } = seeded;
    domains.canvases.save({
      ...input,
      whiteboard: {
        ...seeded.whiteboard!,
        files: {
          fixture: {
            id: 'fixture',
            mimeType: 'image/png',
            created: 1,
            dataURL: 'data:image/png;base64,AA==',
          },
        },
      },
    });
    const read = JSON.parse((await scope.call('whiteboard_read', {})).text!);
    expect(read.canvasId).toBe(created.canvasId);
    expect(read.elements).toHaveLength(6);
    expect(read.files).toEqual([{ id: 'fixture', mimeType: 'image/png' }]);
    expect(JSON.stringify(read)).not.toContain('base64');
    const changed = await scope.call('whiteboard_apply', {
      version: read.version,
      ops: [
        { type: 'select', ids: ['end'] },
        { type: 'update', id: 'end', patch: { backgroundColor: '#e7f5ff' } },
      ],
    });
    expect(changed.isError, changed.text).not.toBe(true);
    const stale = await scope.call('whiteboard_apply', {
      version: read.version,
      ops: [{ type: 'remove', ids: ['start'] }],
    });
    expect(stale.isError).toBe(true);
    const current = domains.canvases.get(created.canvasId);
    expect(current.whiteboard!.elements.find((e) => e.id === 'start')!.isDeleted).toBe(false);
    expect(() =>
      domains.canvases.apply(current.id, current.version, [
        { type: 'rename', title: 'wrong tool' },
      ]),
    ).toThrow('白板');
    const readonly = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanup.push(() => readonly.close());
    attachCanvasTools(
      readonly,
      store,
      domains.canvases,
      domains.canvasWorkflows,
      session,
      true,
      () => {},
    );
    await expect(
      readonly.call('whiteboard_apply', {
        version: current.version,
        ops: [{ type: 'remove', ids: ['start'] }],
      }),
    ).rejects.toThrow('没有权限');
  });
  it('merges changes to separate elements and flags competing edits to the same element', () => {
    const base: Canvas = {
      id: 'test',
      title: 'test',
      mode: 'whiteboard',
      version: 1,
      updatedAt: 1,
      nodes: [],
      edges: [],
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: initial(),
    };
    const local = {
      ...base,
      whiteboard: applyWhiteboardOperations(base.whiteboard!, [
        { type: 'update', id: 'start', patch: { backgroundColor: '#fff' } },
      ]).scene,
    };
    const remote = {
      ...base,
      version: 2,
      whiteboard: applyWhiteboardOperations(base.whiteboard!, [
        { type: 'update', id: 'end', patch: { backgroundColor: '#000' } },
      ]).scene,
    };
    const merged = mergeCanvasChanges(base, local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.canvas.whiteboard!.elements.find((e) => e.id === 'start')!.backgroundColor).toBe(
      '#fff',
    );
    expect(merged.canvas.whiteboard!.elements.find((e) => e.id === 'end')!.backgroundColor).toBe(
      '#000',
    );
    const conflicting = {
      ...base,
      whiteboard: applyWhiteboardOperations(base.whiteboard!, [
        { type: 'update', id: 'start', patch: { backgroundColor: '#f00' } },
      ]).scene,
    };
    expect(mergeCanvasChanges(base, local, conflicting).conflicts.length).toBeGreaterThan(0);
  });
});
