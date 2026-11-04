import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { Store } from '../../../electron/services/storage/store';
import {
  DataMaintenance,
  applyPendingRestore,
  decryptBackup,
  encryptBackup,
} from '../../../electron/services/storage/data-maintenance';
import { createDomainServices } from '../../../electron/modules/domain-services';
import { Canvases, canvasWriteSchema } from '../../../electron/modules/canvas/canvas';
import { applyWhiteboardOperations } from '../../../electron/modules/canvas/whiteboard';
import { comfyConfig, comfyHash } from '../../../electron/modules/canvas/comfyui-format';
import { ApplicationEvents } from '../../../electron/core/application-events';
import type { TaskService } from '../../../electron/core/task-contracts';
import type { Session } from '../../../src/shared/types';
import { emptyWhiteboard } from '../../../src/shared/whiteboard';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
const codec = { encrypt: (value: string) => value, decrypt: (value: string) => value };
const password = 'canvas-backup-password';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=';
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cosail-data-maintenance-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:', codec);
  cleanup.push(() => store.close());
  return { root, store, maintenance: new DataMaintenance(store, root) };
}

describe('canvas work-data backup', () => {
  it('roundtrips workflow and whiteboard files, execution history, source imports and session bindings', async () => {
    const { root, store, maintenance } = fixture();
    const domains = createDomainServices(store, root);
    cleanup.push(() => domains.canvasWorkflows.stop());
    const events = new ApplicationEvents(() => {});
    const start = vi.fn(() => {
      throw new Error('This local workflow must not start a model or remote task');
    });
    domains.canvasWorkflows.configure(
      { start, cancel: vi.fn(), setSessionPermission: vi.fn() } as unknown as TaskService,
      events,
    );
    const { canvases, canvasWorkflows } = domains;
    const workflow = canvases.save({
      title: '备份中的工作流',
      nodes: [{ id: 'text', title: '输入', kind: 'text', text: '保留执行结果', x: 0, y: 0 }],
      edges: [],
      selection: ['text'],
      viewport: { x: 40, y: 80, zoom: 1.2 },
      execution: { concurrency: 3, maxSteps: 200 },
    });
    const session = store.createSession();
    store.setSessionPermission(session.id, 'ask');
    const run = canvasWorkflows.start({
      canvasId: workflow.id,
      version: workflow.version,
      sessionId: session.id,
    });
    await expect.poll(() => canvases.runs.get(run.id).status).toBe('completed');
    const history = canvases.runs.get(run.id);
    expect(history.nodes.text.output?.text).toBe('保留执行结果');

    const scene = emptyWhiteboard();
    scene.files.image = {
      id: 'image',
      mimeType: 'image/png',
      dataURL: 'data:image/png;base64,' + png,
      created: 1,
    };
    const whiteboard = canvases.save({
      mode: 'whiteboard',
      title: '备份中的白板',
      nodes: [],
      edges: [],
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: applyWhiteboardOperations(scene, [
        { type: 'add', element: { id: 'shape', type: 'rectangle', x: 0, y: 0, text: '设计说明' } },
        { type: 'add', element: { id: 'picture', type: 'image', fileId: 'image', x: 400, y: 0 } },
      ]).scene,
    });
    canvases.bind(session.id, whiteboard.id);
    const raw = {
      '1': { class_type: 'TextImage', inputs: { text: 'cat', seed: 1 } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'backup' } },
    };
    const imported = await canvasWorkflows.comfy.import(JSON.stringify(raw));
    const sourceId = comfyConfig(imported.nodes[0])!.sourceId;
    const source = canvases.imports.get(sourceId);
    expect(source).toMatchObject({ raw, hash: comfyHash(raw), format: 'api' });
    expect(store.list('canvas')).toEqual([]);
    expect(store.list('canvasRun')).toEqual([]);

    const backup = maintenance.backup(password);
    const entries = unzipSync(decryptBackup(backup, password));
    for (const definition of [workflow, whiteboard, imported]) {
      const bytes = entries[`.tzhou/canvas/definitions/${definition.id}.json`];
      expect(Buffer.from(bytes)).toEqual(readFileSync(canvases.definitions.file(definition.id)));
      const parsed = JSON.parse(Buffer.from(bytes).toString());
      const { updatedAt: _updatedAt, ...write } = parsed;
      expect(canvasWriteSchema.parse(write)).toEqual(write);
    }
    expect(Buffer.from(entries[`.tzhou/canvas/runs/${run.id}.json`])).toEqual(
      readFileSync(canvases.runs.file(run.id)),
    );
    expect(Buffer.from(entries[`.tzhou/canvas/imports/${sourceId}.json`])).toEqual(
      readFileSync(canvases.imports.file(sourceId)),
    );

    const target = path.join(root, 'restored');
    mkdirSync(target);
    new DataMaintenance(store, target).prepareRestore(backup, password);
    applyPendingRestore(target);
    const restoredStore = new Store(path.join(target, 'tongzhou.db'), codec);
    cleanup.push(() => restoredStore.close());
    const restored = new Canvases(restoredStore, target);
    expect(restored.state().canvases).toHaveLength(3);
    for (const definition of [workflow, whiteboard, imported])
      expect(restored.get(definition.id)).toEqual(definition);
    expect(restored.state(workflow.id).runs).toEqual([history]);
    expect(restored.imports.get(sourceId)).toEqual(source);
    expect(restored.get(whiteboard.id).whiteboard?.files.image.dataURL).toBe(
      'data:image/png;base64,' + png,
    );
    expect(restoredStore.get<Session>('session', session.id)).toEqual(
      store.get<Session>('session', session.id),
    );
    expect(start).not.toHaveBeenCalled();
    expect(existsSync(path.join(target, 'restore-pending'))).toBe(false);
  });

  it.each([
    '.tzhou/canvas/definitions/not-a-uuid.json',
    '.tzhou/canvas/definitions/------------------------------------.json',
    '.tzhou/canvas/definitions/11111111-1111-4111-8111-111111111111.json.tmp',
    '.tzhou/canvas/runs/11111111-1111-4111-8111-111111111111.js',
    '.tzhou/canvas/imports/nested/11111111-1111-4111-8111-111111111111.json',
    '.tzhou/canvas/other/11111111-1111-4111-8111-111111111111.json',
  ])('rejects unsupported canvas record paths before staging: %s', (name) => {
    const { root, maintenance } = fixture();
    const backup = encryptBackup(zipSync({ [name]: Buffer.from('{}') }), password);
    expect(() => maintenance.prepareRestore(backup, password)).toThrow('文件路径');
    expect(existsSync(path.join(root, 'restore-pending'))).toBe(false);
  });
});
