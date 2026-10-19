import { CanvasNodePlugins } from './node-plugins';
import { canvasAgentId, builtinAgent, isCanvasAgent } from '../../../src/shared/builtin-agents';
import {
  validateCanvasPorts,
  validateCanvasPortMultiplicity,
} from '../../../src/shared/canvas-ports';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FileRecords, managedDirectory } from '../../services/storage/local-files';
import { z } from 'zod';
import { whiteboardSceneSchema, applyWhiteboardOperations } from './whiteboard';
import type { Store } from '../../services/storage/store';
import type { Canvas, CanvasRun, CanvasState, CanvasOperation } from '../../../src/shared/canvas';

const id = z.string().min(1).max(120);
export const resourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), id: z.uuid(), version: z.number().int().positive() }),
  z.object({ kind: z.literal('artifact'), id: z.uuid() }),
  z.object({ kind: z.literal('message'), id: z.uuid(), sessionId: z.uuid() }),
  z.object({
    kind: z.literal('file'),
    projectId: z.uuid(),
    path: z.string().min(1).max(1000),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
]);
const valueTypeSchema = z.union([
  z.enum(['text', 'image', 'video', 'audio', 'resource', 'number', 'boolean', 'json']),
  z.templateLiteral(['comfyui:', z.string().max(100)]),
]);
const portSchema = z.object({
  id,
  label: z.string().max(200),
  types: z.array(valueTypeSchema).min(1).max(20),
  multiple: z.boolean().optional(),
});
export const nodeSchema = z
  .object({
    id,
    kind: z.enum(['text', 'resource', 'agent', 'image', 'video', 'audio', 'save', 'plugin']),
    pluginId: id.optional(),
    definition: z
      .object({
        id: z.string().regex(/^comfyui\.[a-f0-9]{24}$/),
        name: z.string().min(1).max(200),
        kind: z.literal('plugin'),
        version: z.literal(1),
        apiVersion: z.literal(1),
        adapter: z.literal('comfyui'),
        cache: z.literal('never'),
        description: z.string().max(200).optional(),
        inputs: z.array(valueTypeSchema).max(200),
        outputs: z.array(valueTypeSchema).max(200),
        ports: z.object({
          inputs: z.array(portSchema).max(200),
          outputs: z.array(portSchema).max(200),
        }),
        configSchema: z.record(z.string(), z.json()),
      })
      .refine((value) => JSON.stringify(value).length <= 64000, '节点定义过大')
      .optional(),
    config: z
      .record(z.string(), z.json())
      .refine((v) => JSON.stringify(v).length <= 32000, '节点配置过大')
      .optional(),
    title: z.string().trim().min(1).max(180),
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
    width: z.number().min(160).max(1600).optional(),
    height: z.number().min(120).max(1600).optional(),
    group: z.string().trim().min(1).max(80).optional(),
    text: z.string().max(32000).optional(),
    resource: resourceSchema.optional(),
    textSource: z
      .object({ title: z.string().max(180), url: z.url().max(4000).optional() })
      .optional(),
    media: z
      .object({
        pluginId: id.optional(),
        tool: id.optional(),
        model: id.optional(),
        count: z.number().int().min(1).max(8).optional(),
        mode: z.enum(['text', 'reference', 'first-frame', 'frames', 'existing']).optional(),
        referenceImages: z.array(resourceSchema).max(8).optional(),
        firstFrame: resourceSchema.optional(),
        lastFrame: resourceSchema.optional(),
        aspectRatio: z.string().max(20).optional(),
        resolution: z.string().max(40).optional(),
        duration: z.number().min(1).max(120).optional(),
        voice: z.string().max(120).optional(),
        speed: z.number().min(0.25).max(4).optional(),
        parameters: z.record(z.string(), z.json()).optional(),
        destination: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('artifacts') }),
            z.object({
              kind: z.literal('content'),
              libraryId: z.union([z.literal('default'), z.uuid()]),
              folderId: z.uuid().nullish(),
            }),
            z.object({ kind: z.literal('directory'), path: z.string().min(1).max(4096) }),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    providerId: id.optional(),
    model: id.optional(),
    agentId: z.string().max(120).optional(),
    libraryId: z.union([z.literal('default'), z.uuid()]).optional(),
    folderId: z.uuid().nullable().optional(),
  })
  .strict();
export const edgeSchema = z
  .object({
    id,
    from: id,
    to: id,
    kind: z.enum(['reference', 'dependency']),
    fromPort: id.optional(),
    toPort: id.optional(),
  })
  .strict();
export const canvasWriteSchema = z
  .object({
    mode: z.enum(['workflow', 'whiteboard']).optional(),
    whiteboard: whiteboardSceneSchema.optional(),
    id: z.uuid().optional(),
    version: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(180),
    nodes: z.array(nodeSchema).max(200),
    edges: z.array(edgeSchema).max(800),
    viewport: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().min(0.15).max(3),
    }),
    selection: z.array(id).max(200),
  })
  .strict();
export const operationsSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('put_node'), node: nodeSchema }),
      z.object({ type: z.literal('remove_node'), id }),
      z.object({ type: z.literal('put_edge'), edge: edgeSchema }),
      z.object({ type: z.literal('remove_edge'), id }),
      z.object({ type: z.literal('select'), nodeIds: z.array(id).max(200) }),
      z.object({ type: z.literal('rename'), title: z.string().trim().min(1).max(180) }),
    ]),
  )
  .min(1)
  .max(200);
export const executeSchema = z
  .object({
    canvasId: z.uuid(),
    version: z.number().int().positive(),
    sessionId: z.uuid(),
    nodeIds: z.array(id).min(1).max(50).optional(),
    reuse: z.boolean().optional(),
    resumeRunId: z.uuid().optional(),
    saveResource: z.boolean().optional(),
    regenerate: z
      .object({
        nodeId: id,
        indices: z.array(z.number().int().min(0).max(7)).min(1).max(8).optional(),
        action: z.enum(['generate', 'resume', 'save']).optional(),
        sourceRunId: z.uuid().optional(),
      })
      .strict()
      .optional(),
    providerId: id.optional(),
    model: id.optional(),
  })
  .strict();

/** Dependency edges schedule work. Reference edges only supply context. */
export function executionOrder(canvas: Pick<Canvas, 'nodes' | 'edges'>, selected?: string[]) {
  const ids = new Set(canvas.nodes.map((n) => n.id));
  if (ids.size !== canvas.nodes.length) throw new Error('节点 ID 重复');
  const edgeIds = new Set<string>();
  for (const edge of canvas.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || edgeIds.has(edge.id))
      throw new Error('连线无效或重复');
    edgeIds.add(edge.id);
  }
  const wanted = new Set(selected ?? ids);
  if ([...wanted].some((v) => !ids.has(v))) throw new Error('选中节点不存在');
  const visiting = new Set<string>(),
    done = new Set<string>(),
    order: string[] = [];
  const visit = (nodeId: string) => {
    if (visiting.has(nodeId)) throw new Error('执行依赖存在循环');
    if (done.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of canvas.edges.filter((e) => e.to === nodeId && e.kind === 'dependency'))
      visit(edge.from);
    visiting.delete(nodeId);
    done.add(nodeId);
    order.push(nodeId);
  };
  for (const nodeId of wanted) visit(nodeId);
  return order;
}

export class Canvases {
  readonly plugins = new CanvasNodePlugins();
  readonly definitions: FileRecords<Canvas>;
  readonly runs: FileRecords<CanvasRun>;
  readonly imports: FileRecords<import('./comfyui').ComfySource>;
  constructor(
    private store: Store,
    dataDir: string,
  ) {
    const root = managedDirectory(dataDir, 'canvas');
    this.definitions = new FileRecords(path.join(root, 'definitions'));
    this.runs = new FileRecords(path.join(root, 'runs'));
    this.imports = new FileRecords(path.join(root, 'imports'));
    this.migrate('canvas', this.definitions);
    this.migrate('canvasRun', this.runs);
    for (const run of this.runs.list())
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.error = '应用退出，工作流已中断；已完成的结果可在重试时复用。';
        run.endedAt = Date.now();
        for (const step of Object.values(run.nodes)) {
          if (step.status === 'running' || step.status === 'pending') step.status = 'cancelled';
          for (const item of step.generation ?? [])
            if (item.status === 'running' || item.status === 'pending') item.status = 'cancelled';
        }
        this.runs.put(run);
      }
  }
  private migrate<T extends { id: string }>(kind: string, records: FileRecords<T>) {
    for (const old of this.store.list<T>(kind)) {
      if (!existsSync(records.file(old.id))) records.put(old);
      // An existing file is authoritative. Verify it before removing the legacy row.
      records.get(old.id);
      this.store.remove(kind, old.id);
    }
  }
  get(id: string): Canvas {
    return this.definitions.get(z.uuid().parse(id));
  }
  state(id?: string): CanvasState {
    return {
      plugins: this.plugins.list(id ? this.get(id).nodes : []),
      canvases: this.definitions
        .list()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, title, version, updatedAt, mode }) => ({
          id,
          title,
          version,
          updatedAt,
          mode,
        })),
      canvas: id ? this.get(id) : null,
      runs: id
        ? this.runs
            .list()
            .filter((r) => r.canvasId === id)
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 30)
        : [],
    };
  }
  save(raw: unknown) {
    const p = canvasWriteSchema.parse(raw),
      old = p.id ? this.get(p.id) : undefined;
    if (old && p.version !== old.version) throw new Error('画布已更新，请重新载入后保存');
    if (p.mode === 'whiteboard') {
      if (!p.whiteboard || p.nodes.length || p.edges.length || p.selection.length)
        throw new Error('白板需使用图形场景，不能包含工作流节点');
    } else if (p.whiteboard) throw new Error('工作流不能包含白板场景');
    if (old && old.mode !== p.mode && (old.mode === 'whiteboard' || p.mode === 'whiteboard'))
      throw new Error('请新建另一种类型的画布，不能覆盖现有画布类型');
    executionOrder(p);
    const definitions = this.plugins.list(p.nodes);
    for (const edge of p.edges) {
      const source = p.nodes.find((n) => n.id === edge.from)!,
        target = p.nodes.find((n) => n.id === edge.to)!;
      const from = definitions.find((d) => d.id === (source.pluginId ?? source.kind)),
        to = definitions.find((d) => d.id === (target.pluginId ?? target.kind));
      if (from && to) {
        validateCanvasPorts(edge, source, target, from, to);
        validateCanvasPortMultiplicity(p, edge, target, to);
      }
    }
    if (p.selection.some((v) => !p.nodes.some((n) => n.id === v)))
      throw new Error('选区包含不存在的节点');
    const next = {
      ...p,
      id: old?.id ?? randomUUID(),
      version: (old?.version ?? 0) + 1,
      updatedAt: Date.now(),
    } satisfies Canvas;
    this.definitions.put(next);
    return next;
  }
  apply(id: string, version: number, raw: unknown) {
    const current = this.get(id);
    if (current.mode === 'whiteboard')
      throw new Error('这是白板，请使用 whiteboard_read 和 whiteboard_apply');
    if (current.version !== version) throw new Error('画布已更新，请重新读取当前版本');
    return this.applyOperations(current, raw);
  }
  applyWhiteboard(id: string, version: number, raw: unknown) {
    const current = this.get(id);
    if (current.mode !== 'whiteboard' || !current.whiteboard) throw new Error('当前画布不是白板');
    if (current.version !== version)
      throw new Error('白板已更新，请重新读取最新版本，保留用户手动修改');
    const { scene, title } = applyWhiteboardOperations(current.whiteboard, raw);
    const { updatedAt: _, ...input } = current;
    return this.save({ ...input, title: title ?? current.title, whiteboard: scene });
  }
  create(title: string, raw: unknown) {
    return this.applyOperations(
      {
        id: randomUUID(),
        version: 1,
        updatedAt: 0,
        title,
        nodes: [],
        edges: [],
        selection: [],
        viewport: { x: 40, y: 40, zoom: 1 },
      },
      raw,
      true,
    );
  }
  private applyOperations(current: Canvas, raw: unknown, create = false) {
    for (const op of operationsSchema.parse(raw) as CanvasOperation[]) {
      if (op.type === 'put_node')
        current.nodes = [...current.nodes.filter((n) => n.id !== op.node!.id), op.node!];
      if (op.type === 'remove_node') {
        current.nodes = current.nodes.filter((n) => n.id !== op.id);
        current.edges = current.edges.filter((e) => e.from !== op.id && e.to !== op.id);
        current.selection = current.selection.filter((v) => v !== op.id);
      }
      if (op.type === 'put_edge')
        current.edges = [...current.edges.filter((e) => e.id !== op.edge!.id), op.edge!];
      if (op.type === 'remove_edge') current.edges = current.edges.filter((e) => e.id !== op.id);
      if (op.type === 'select') current.selection = op.nodeIds!;
      if (op.type === 'rename') current.title = op.title!;
    }
    const { updatedAt: _, ...input } = current;
    return this.save(create ? { ...input, id: undefined, version: undefined } : input);
  }
  delete(id: string, version: number) {
    if (this.get(id).version !== version) throw new Error('画布已更新');
    if (this.runs.list().some((r) => r.canvasId === id && r.status === 'running'))
      throw new Error('请先停止工作流');
    this.definitions.remove(id);
    for (const s of this.store.list<import('../../../src/shared/types').Session>('session'))
      if (s.activeCanvasId === id || s.canvasIds?.includes(id))
        this.store.put('session', {
          ...s,
          activeCanvasId: s.activeCanvasId === id ? undefined : s.activeCanvasId,
          agentId:
            s.activeCanvasId === id && isCanvasAgent(builtinAgent(s.agentId) ?? {})
              ? ''
              : s.agentId,
          canvasIds: s.canvasIds?.filter((v) => v !== id),
        });
  }
  bind(sessionId: string, canvasId: string | null) {
    const session = this.store.get<import('../../../src/shared/types').Session>(
      'session',
      sessionId,
    );
    if (session.canvasContext) throw new Error('执行节点不能更改画布关联');
    const canvas = canvasId ? this.get(canvasId) : undefined;
    const canvasIds = canvasId
      ? [...new Set([...(session.canvasIds ?? []), canvasId])]
      : session.canvasIds;
    this.store.put('session', {
      ...session,
      canvasIds,
      activeCanvasId: canvasId ?? undefined,
      agentId: canvas
        ? canvasAgentId(canvas.mode)
        : isCanvasAgent(builtinAgent(session.agentId) ?? {})
          ? ''
          : session.agentId,
    });
  }
}
