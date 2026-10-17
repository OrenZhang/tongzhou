import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../../../electron/services/storage/store';
import { createDomainServices } from '../../../electron/modules/domain-services';
import { ApplicationEvents } from '../../../electron/core/application-events';
import { Canvases } from '../../../electron/modules/canvas/canvas';
import { attachCanvasTools } from '../../../electron/modules/canvas/canvas-tools';
import { ToolScope } from '../../../electron/core/tools/extensions';
import type { CanvasNode, CanvasRun, CanvasWrite } from '../../../src/shared/canvas';
import type { Run } from '../../../src/shared/types';

const cleanups: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
const node = (id: string, kind: CanvasNode['kind'] = 'text', text = '输入'): CanvasNode => ({
  id,
  kind,
  title: id,
  x: 0,
  y: 0,
  text,
});
const graph = (nodes: CanvasNode[]): CanvasWrite => ({
  title: '通用流程',
  nodes,
  edges: [],
  selection: [],
  viewport: { x: 40, y: 40, zoom: 1 },
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-canvas-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanups.push(() => store.close());
  const domains = createDomainServices(store, root),
    events = new ApplicationEvents(() => {}),
    session = store.createSession();
  store.setSessionPermission(session.id, 'full-access');
  store.put('provider', {
    id: 'test',
    name: 'Test',
    enabled: true,
    protocol: 'openai-chat',
    baseUrl: 'http://localhost',
    auth: 'none',
    models: ['model'],
    thinkingEnabled: true,
    reasoningEffort: 'high',
  });
  store.put('session', {
    ...store.get<any>('session', session.id),
    providerId: 'test',
    model: 'model',
  });
  let pending: (() => void)[] = [];
  const tasks = {
    start: vi.fn((input: any) => {
      const run = {
        id: randomUUID(),
        sessionId: input.sessionId,
        status: 'running',
        startedAt: Date.now(),
        providerId: input.providerId,
        model: input.model,
        inputTokens: 0,
        outputTokens: 0,
        agentName: '',
      } satisfies Run;
      store.put('run', run);
      const finish = () => {
        const completed = { ...run, status: 'completed' as const };
        store.put('run', completed);
        store.message({
          id: randomUUID(),
          sessionId: run.sessionId,
          runId: run.id,
          role: 'assistant',
          content: '根据人物、场景与剧本完成分镜建议。',
          status: 'complete',
          createdAt: Date.now(),
        });
        events.emit('lifecycle', completed, 'completed');
      };
      pending.push(finish);
      return run.id;
    }),
    cancel: vi.fn(async () => {}),
    setSessionPermission: vi.fn((id: string, mode: any) => store.setSessionPermission(id, mode)),
  };
  domains.canvasWorkflows.configure(tasks as any, events);
  return {
    root,
    store,
    domains,
    events,
    session,
    tasks,
    finish: () => {
      const p = pending;
      pending = [];
      p.forEach((fn) => fn());
    },
  };
}
async function done(f: ReturnType<typeof fixture>, id: string) {
  await expect.poll(() => f.domains.canvases.runs.get(id).status).not.toBe('running');
  return f.domains.canvases.runs.get(id);
}

describe('generic canvas and workflow', () => {
  it('saves across instances, rejects conflicts, cleans dangling edges, and rejects dependency cycles atomically', () => {
    const f = fixture(),
      c = f.domains.canvases.save({
        ...graph([node('a'), node('b')]),
        edges: [{ id: 'e', from: 'a', to: 'b', kind: 'dependency' }],
      });
    expect(new Canvases(f.store, f.root).get(c.id)).toEqual(c);
    expect(() =>
      f.domains.canvases.apply(c.id, c.version, [
        { type: 'put_edge', edge: { id: 'back', from: 'b', to: 'a', kind: 'dependency' } },
      ]),
    ).toThrow('循环');
    expect(f.domains.canvases.get(c.id).version).toBe(1);
    const next = f.domains.canvases.apply(c.id, 1, [{ type: 'remove_node', id: 'a' }]);
    expect(next.edges).toEqual([]);
    expect(() => f.domains.canvases.apply(c.id, 1, [{ type: 'rename', title: '冲突' }])).toThrow(
      '更新',
    );
    expect(() =>
      f.domains.canvases.save({
        ...graph([node('a')]),
        edges: [{ id: 'e', from: 'missing', to: 'a', kind: 'reference' }],
      }),
    ).toThrow('连线');
  });
  it('registers and disposes node plugins, validates configuration, supplies defaults and passes upstream inputs', async () => {
    const f = fixture(),
      plugins = f.domains.canvases.plugins;
    const definition = {
      id: 'example.outline',
      name: '大纲节点',
      kind: 'plugin' as const,
      version: 2,
      inputs: ['text' as const],
      outputs: ['text' as const],
    };
    const registration = {
      definition,
      schema: z.object({ prefix: z.string().default('大纲') }),
      execute: ({ node, inputs }: any) => ({
        text: String(node.config.prefix) + '：' + inputs.map((o: any) => o.text).join(),
        resources: [],
      }),
    };
    const dispose = plugins.register(registration);
    expect(() => plugins.register(registration)).toThrow('已注册');
    expect(f.domains.canvases.state().plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: definition.id,
          version: 2,
          configSchema: expect.objectContaining({ type: 'object' }),
        }),
      ]),
    );
    const c = f.domains.canvases.save({
      ...graph([
        node('source', 'text', '正文'),
        { ...node('extension', 'plugin'), pluginId: definition.id },
      ]),
      edges: [{ id: 'e', from: 'source', to: 'extension', kind: 'dependency' }],
    });
    const run = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: c.version,
      sessionId: f.session.id,
    });
    const completed = await done(f, run.id);
    expect(completed.nodes.extension.output?.text).toBe('大纲：正文');
    expect(completed.nodes.extension.plugin).toEqual({ id: definition.id, version: 2 });
    dispose();
    expect(() =>
      f.domains.canvasWorkflows.start({
        canvasId: c.id,
        version: c.version,
        sessionId: f.session.id,
      }),
    ).toThrow('插件不可用');
    plugins.register(registration);
    const invalid = f.domains.canvases.apply(c.id, c.version, [
      { type: 'put_node', node: { ...c.nodes[1], config: { prefix: 3 } } },
    ]);
    expect(() =>
      f.domains.canvasWorkflows.start({
        canvasId: c.id,
        version: invalid.version,
        sessionId: f.session.id,
      }),
    ).toThrow();
  });
  it('stores definitions and run snapshots as independent JSON files and reopens them', async () => {
    const f = fixture(),
      c = f.domains.canvases.save(graph([node('text')]));
    const started = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: 1,
      sessionId: f.session.id,
    });
    const run = await done(f, started.id);
    const root = path.join(f.root, '.tzhou', 'canvas');
    expect(
      JSON.parse(readFileSync(path.join(root, 'definitions', c.id + '.json'), 'utf8')),
    ).toEqual(c);
    expect(JSON.parse(readFileSync(path.join(root, 'runs', run.id + '.json'), 'utf8'))).toEqual(
      run,
    );
    expect(f.store.list('canvas')).toEqual([]);
    expect(f.store.list('canvasRun')).toEqual([]);
    expect(new Canvases(f.store, f.root).state(c.id)).toMatchObject({ canvas: c, runs: [run] });
  });
  it('migrates legacy rows without overwriting newer files, preserving completed outputs and bindings', () => {
    const f = fixture(),
      c = f.domains.canvases.save(graph([node('text')]));
    const run: CanvasRun = {
      id: randomUUID(),
      canvasId: c.id,
      sessionId: f.session.id,
      definition: c,
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      nodes: { text: { status: 'completed', output: { text: '保留结果', resources: [] } } },
    };
    f.domains.canvases.bind(f.session.id, c.id);
    f.domains.canvases.definitions.remove(c.id);
    f.store.put('canvas', c);
    f.store.put('canvasRun', run);
    const migrated = new Canvases(f.store, f.root);
    expect(migrated.get(c.id)).toEqual(c);
    expect(migrated.runs.get(run.id)).toEqual(run);
    expect(f.store.get<any>('session', f.session.id).activeCanvasId).toBe(c.id);
    expect(f.store.list('canvas')).toEqual([]);
    expect(f.store.list('canvasRun')).toEqual([]);
    migrated.apply(c.id, c.version, [{ type: 'rename', title: '较新的文件' }]);
    f.store.put('canvas', c);
    expect(new Canvases(f.store, f.root).get(c.id).title).toBe('较新的文件');
    expect(f.store.list('canvas')).toEqual([]);
  });
  it('keeps legacy data when its destination file cannot be verified', () => {
    const f = fixture(),
      c = f.domains.canvases.save(graph([node('text')]));
    f.store.put('canvas', c);
    writeFileSync(f.domains.canvases.definitions.file(c.id), '{invalid');
    expect(() => new Canvases(f.store, f.root)).toThrow();
    expect(f.store.get('canvas', c.id)).toEqual(c);
    expect(existsSync(f.domains.canvases.definitions.file(c.id))).toBe(true);
  });
  it('executes dependencies, publishes through content service, reuses results, and invalidates changed inputs', async () => {
    const f = fixture(),
      c = f.domains.canvases.save({
        ...graph([
          node('source', 'text', '小说正文'),
          node('agent', 'agent', '生成分镜'),
          node('save', 'save'),
        ]),
        edges: [
          { id: 'a', from: 'source', to: 'agent', kind: 'dependency' },
          { id: 'b', from: 'agent', to: 'save', kind: 'dependency' },
        ],
      });
    const run = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: 1,
      sessionId: f.session.id,
      nodeIds: ['save'],
      reuse: true,
    });
    await expect.poll(() => f.tasks.start.mock.calls.length).toBe(1);
    f.finish();
    const result = await done(f, run.id);
    expect(result.status).toBe('completed');
    expect(result.nodes.save.output!.resources[0].kind).toBe('content');
    const docId = (result.nodes.save.output!.resources[0] as any).id;
    expect(f.domains.content.document(docId).content).toContain('分镜');
    const second = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: 1,
      sessionId: f.session.id,
      reuse: true,
    });
    const cached = await done(f, second.id);
    expect(cached.nodes.agent.status).toBe('cached');
    expect(cached.nodes.agent.taskRunId).toBe(result.nodes.agent.taskRunId);
    expect(f.tasks.start).toHaveBeenCalledTimes(1);
    const next = f.domains.canvases.apply(c.id, 1, [
      { type: 'put_node', node: node('source', 'text', '修改后的小说') },
    ]);
    const third = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: next.version,
      sessionId: f.session.id,
      reuse: true,
    });
    await expect.poll(() => f.tasks.start.mock.calls.length).toBe(2);
    f.finish();
    expect((await done(f, third.id)).status).toBe('completed');
  });
  it('pins a definition during edits and stops descendants on cancel without replaying side effects', async () => {
    const f = fixture(),
      c = f.domains.canvases.save({
        ...graph([node('a', 'agent'), node('b', 'save')]),
        edges: [{ id: 'ab', from: 'a', to: 'b', kind: 'dependency' }],
      });
    const r = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: 1,
      sessionId: f.session.id,
    });
    await expect.poll(() => f.tasks.start.mock.calls.length).toBe(1);
    f.domains.canvases.apply(c.id, 1, [{ type: 'rename', title: '下一版' }]);
    expect(f.domains.canvases.runs.get(r.id).definition.title).toBe('通用流程');
    await f.domains.canvasWorkflows.cancel(r.id);
    const stopped = await done(f, r.id);
    expect(stopped.status).toBe('cancelled');
    expect(stopped.nodes.b.status).toBe('cancelled');
    f.finish();
    expect(f.domains.knowledge.all()).toHaveLength(0);
    expect(f.events.listenerCount('lifecycle')).toBe(0);
  });
  it('reports missing image capability as failure instead of treating a textual claim as an image', async () => {
    const f = fixture(),
      c = f.domains.canvases.save(graph([node('image', 'image', '生成人物')])),
      r = f.domains.canvasWorkflows.start({ canvasId: c.id, version: 1, sessionId: f.session.id });
    await expect.poll(() => f.tasks.start.mock.calls.length).toBe(1);
    f.finish();
    const result = await done(f, r.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('未返回图片');
  });
  it('reads actual image references as worker attachments and fails stale resource versions', async () => {
    const f = fixture(),
      png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
        'base64',
      ),
      d = f.domains.knowledge.importFile('人物.png', png);
    const ref = { kind: 'content' as const, id: d.id, version: d.version };
    const c = f.domains.canvases.save({
      ...graph([{ ...node('resource', 'resource'), resource: ref }, node('agent', 'agent')]),
      edges: [{ id: 'input', from: 'resource', to: 'agent', kind: 'reference' }],
    });
    const r = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: 1,
      sessionId: f.session.id,
      nodeIds: ['agent'],
    });
    await expect.poll(() => f.tasks.start.mock.calls.length).toBe(1);
    const args = f.tasks.start.mock.calls[0][0];
    expect(args.attachmentIds).toHaveLength(1);
    expect(f.domains.attachments.content(args.attachmentIds[0])).toBe(
      'data:image/png;base64,' + png.toString('base64'),
    );
    f.finish();
    await done(f, r.id);
    expect(() =>
      f.domains.canvasWorkflows.resources.validate({ ...ref, version: d.version + 1 }),
    ).toThrow('版本');
  });
  it('restricts files to the selected project, detects changed files and rejects traversal', async () => {
    const f = fixture(),
      projectId = randomUUID();
    writeFileSync(path.join(f.root, 'input.txt'), 'first');
    f.store.put('project', { id: projectId, path: f.root, name: '本地' });
    const output = await f.domains.canvasWorkflows.resources.resolve({
      kind: 'file',
      projectId,
      path: 'input.txt',
    });
    writeFileSync(path.join(f.root, 'input.txt'), 'changed');
    await expect(f.domains.canvasWorkflows.resources.resolve(output.resources[0])).rejects.toThrow(
      '变化',
    );
    await expect(
      f.domains.canvasWorkflows.resources.resolve({ kind: 'file', projectId, path: '../outside' }),
    ).rejects.toThrow('范围');
  });
  it('enforces session permissions, isolates node workers and exposes read-only tools without write handlers', async () => {
    const f = fixture(),
      c = f.domains.canvases.save(graph([node('a')]));
    f.store.setSessionPermission(f.session.id, 'read-only');
    expect(() =>
      f.domains.canvasWorkflows.start({ canvasId: c.id, version: 1, sessionId: f.session.id }),
    ).toThrow('只读');
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanups.push(() => scope.close());
    attachCanvasTools(
      scope,
      f.store,
      f.domains.canvases,
      f.domains.canvasWorkflows,
      f.session,
      true,
      () => {},
    );
    expect(scope.specs.map((s) => s.name)).toEqual(['canvas_list', 'canvas_read']);
    const worker = f.store.createSession();
    f.store.put('session', {
      ...worker,
      canvasContext: { canvasId: c.id, workflowRunId: randomUUID(), nodeId: 'a' },
    });
    expect(() =>
      f.domains.canvasWorkflows.start({ canvasId: c.id, version: 1, sessionId: worker.id }),
    ).toThrow('普通会话');
  });
  it('marks interrupted workflow records on restart and keeps completed nodes reusable', async () => {
    const f = fixture(),
      c = f.domains.canvases.save(graph([node('a', 'agent')])),
      r = f.domains.canvasWorkflows.start({ canvasId: c.id, version: 1, sessionId: f.session.id });
    await expect.poll(() => f.tasks.start.mock.calls.length).toBe(1);
    await f.domains.canvasWorkflows.cancel(r.id);
    await done(f, r.id);
    f.domains.canvases.runs.put({ ...f.domains.canvases.runs.get(r.id), status: 'running' });
    new Canvases(f.store, f.root);
    expect(f.domains.canvases.runs.get(r.id).status).toBe('interrupted');
  });
  it('creates canvas batches atomically and clears removed canvas bindings', () => {
    const f = fixture();
    expect(() =>
      f.domains.canvases.create('无效', [
        { type: 'put_edge', edge: { id: 'e', from: 'a', to: 'b', kind: 'dependency' } },
      ]),
    ).toThrow('连线');
    expect(f.domains.canvases.state().canvases).toHaveLength(0);
    const c = f.domains.canvases.create('有效', [{ type: 'put_node', node: node('a') }]);
    expect(c.version).toBe(1);
    f.domains.canvases.bind(f.session.id, c.id);
    f.domains.canvases.delete(c.id, 1);
    expect(f.store.get<any>('session', f.session.id).activeCanvasId).toBeUndefined();
  });
  it('persists actual generated image originals through existing artifact and content owners', async () => {
    const f = fixture(),
      c = f.domains.canvases.save({
        ...graph([node('image', 'image'), node('save', 'save')]),
        edges: [{ id: 'e', from: 'image', to: 'save', kind: 'dependency' }],
      });
    const r = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: 1,
      sessionId: f.session.id,
    });
    await expect.poll(() => f.tasks.start.mock.calls.length).toBe(1);
    const step = f.domains.canvases.runs.get(r.id).nodes.image;
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
      'base64',
    );
    await f.domains.artifacts.save(
      { name: '人物.png', mimeType: 'image/png', data: bytes.toString('base64') },
      { sessionId: step.taskSessionId!, runId: step.taskRunId! },
    );
    f.finish();
    const result = await done(f, r.id);
    expect(result.status).toBe('completed');
    const refs = result.nodes.save.output!.resources;
    expect(refs).toHaveLength(2);
    expect(f.domains.knowledge.originalBytes((refs[1] as any).id)).toEqual(bytes);
  });
  it('propagates live owner permission changes and blocks downstream writes', async () => {
    const f = fixture(),
      c = f.domains.canvases.save({
        ...graph([node('agent', 'agent'), node('save', 'save')]),
        edges: [{ id: 'e', from: 'agent', to: 'save', kind: 'dependency' }],
      });
    const r = f.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: 1,
      sessionId: f.session.id,
    });
    await expect.poll(() => f.tasks.start.mock.calls.length).toBe(1);
    f.store.setSessionPermission(f.session.id, 'read-only');
    f.events.emit('permissionChanged', f.session.id);
    expect(f.tasks.setSessionPermission).toHaveBeenCalledWith(
      f.domains.canvases.runs.get(r.id).nodes.agent.taskSessionId,
      'read-only',
    );
    f.finish();
    const result = await done(f, r.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('只读');
    expect(f.domains.knowledge.all()).toHaveLength(0);
  });
  it('provides direct session tools that create and execute without the management capability', async () => {
    const f = fixture(),
      scope = new ToolScope(
        new AbortController().signal,
        async () => true,
        () => {},
      );
    cleanups.push(() => scope.close());
    f.store.put('capabilityState', { id: 'global', management: false });
    attachCanvasTools(
      scope,
      f.store,
      f.domains.canvases,
      f.domains.canvasWorkflows,
      f.session,
      false,
      () => {},
    );
    const created = await scope.call('canvas_apply', {
      createTitle: '会话直操作',
      ops: [{ type: 'put_node', node: node('text') }],
    });
    expect(created.isError).not.toBe(true);
    const c = JSON.parse(created.text!);
    const executed = await scope.call('canvas_execute', { canvasId: c.id, version: c.version });
    const run = JSON.parse(executed.text!);
    expect((await done(f, run.id)).status).toBe('completed');
    expect(JSON.parse((await scope.call('canvas_read', {})).text!).canvas.id).toBe(c.id);
  });
});
