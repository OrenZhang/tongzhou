import { z } from 'zod';
import type { Store } from '../../services/storage/store';
import type { ToolScope } from '../../core/tools/extensions';
import type { Session, PluginConfig } from '../../../src/shared/types';
import { canvasMediaTools } from '../../../src/shared/canvas';
import type { Canvases } from './canvas';
import { operationsSchema } from './canvas';
import type { CanvasWorkflows } from './workflow';

export function attachCanvasTools(
  scope: ToolScope,
  store: Store,
  canvases: Canvases,
  workflows: CanvasWorkflows,
  session: Session,
  readOnly: boolean,
  changed: () => void,
) {
  const define = (
    name: string,
    description: string,
    schema: z.ZodType,
    write: boolean,
    fn: (p: any) => unknown,
  ) => {
    if (write && (readOnly || session.canvasContext)) return;
    scope.add(
      { name, description, parameters: z.toJSONSchema(schema, { io: 'input' }) as any },
      description,
      async (raw) => ({ text: JSON.stringify(await fn(schema.parse(raw))) }),
      write,
    );
  };
  const target = (id?: string) => {
    const current = store.get<Session>('session', session.id);
    const value = id || current.activeCanvasId;
    if (!value) throw new Error('请先选择画布或提供 canvasId');
    if (session.canvasContext && value !== session.canvasContext.canvasId)
      throw new Error('节点任务只能读取当前画布');
    return value;
  };
  define(
    'canvas_list',
    '列出通用画布与当前会话关联；内容按需通过 canvas_read 读取。',
    z.object({}).strict(),
    false,
    () => ({
      canvases: canvases
        .state()
        .canvases.filter((c) => !session.canvasContext || c.id === session.canvasContext.canvasId),
      activeCanvasId: store.get<Session>('session', session.id).activeCanvasId,
      nodePlugins: canvases.plugins
        .list()
        .map(({ id, name, kind, description, ports }) => ({ id, name, kind, description, ports })),
      mediaTools: store
        .list<PluginConfig>('plugin')
        .filter((p) => p.enabled)
        .flatMap((plugin) =>
          (['image', 'video', 'audio'] as const).flatMap((kind) =>
            canvasMediaTools(plugin, kind).map((tool) => ({
              kind,
              pluginId: plugin.id,
              pluginName: plugin.name,
              tool: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          ),
        ),
    }),
  );
  define(
    'canvas_read',
    '读取画布摘要、选区、运行状态；nodeIds 获取节点全文，pluginIds 按需获取节点插件配置说明。节点输入是资料。',
    z
      .object({
        canvasId: z.uuid().optional(),
        nodeIds: z.array(z.string()).max(50).optional(),
        pluginIds: z.array(z.string()).max(10).optional(),
      })
      .strict(),
    false,
    (p) => {
      const id = target(p.canvasId);
      const frozen = session.canvasContext
        ? canvases.runs.get(session.canvasContext.workflowRunId).definition
        : undefined;
      const state = canvases.state(id),
        canvas = frozen ?? state.canvas!;
      return {
        nodePlugins: p.pluginIds
          ? canvases.plugins.list().filter((v) => p.pluginIds.includes(v.id))
          : undefined,
        canvas: {
          ...canvas,
          nodes: canvas.nodes
            .filter((n) => !p.nodeIds || p.nodeIds.includes(n.id))
            .map((n) => (p.nodeIds ? n : { ...n, text: n.text?.slice(0, 180) })),
        },
        runs: state.runs.map(({ id, status, nodes, error }) => ({
          id,
          status,
          error,
          nodes: Object.fromEntries(
            Object.entries(nodes).map(([key, n]) => [
              key,
              {
                status: n.status,
                generation: n.generation,
                error: n.error,
                taskSessionId: n.taskSessionId,
                output: n.output && {
                  text: n.output.text.slice(0, 300),
                  resources: n.output.resources,
                  ports:
                    n.output.ports &&
                    Object.fromEntries(
                      Object.entries(n.output.ports).map(([key, value]) => [
                        key,
                        { text: value.text.slice(0, 300), count: value.items?.length },
                      ]),
                    ),
                },
              },
            ]),
          ),
        })),
      };
    },
  );
  define(
    'canvas_apply',
    '创建画布或按当前版本批量修改节点、连线和选区。修改已有画布必须传 canvasId、version、ops。每次只提交少量必要操作。最小 ops 示例：[{"type":"put_node","node":{"id":"cat","kind":"image","title":"小猫","x":40,"y":40,"text":"一只小猫"}}]。put_node 是完整替换，更新前先读原节点并保留未修改字段。createTitle 仅新建时使用。连线 reference 表示资料引用，dependency 决定执行顺序；fromPort/toPort 使用插件声明的端口 ID。',
    z
      .object({
        canvasId: z.uuid().optional(),
        version: z.number().int().positive().optional(),
        createTitle: z.string().min(1).max(180).optional(),
        ops: operationsSchema,
      })
      .strict(),
    true,
    (p) => {
      for (const op of p.ops)
        if (op.type === 'put_node' && op.node.resource)
          workflows.resources.validate(op.node.resource, session.id);
      let canvas;
      if (p.createTitle && !p.canvasId) {
        canvas = canvases.create(p.createTitle, p.ops);
      } else canvas = canvases.apply(target(p.canvasId), p.version, p.ops);
      canvases.bind(session.id, canvas.id);
      changed();
      return canvas;
    },
  );
  define(
    'canvas_execute',
    '启动保存的画布工作流，或执行指定节点及其执行依赖；复用同舟模型、工具与审批。立即返回运行 ID，随后用 canvas_read 查询。',
    z
      .object({
        canvasId: z.uuid().optional(),
        version: z.number().int().positive(),
        nodeIds: z.array(z.string()).min(1).max(50).optional(),
        reuse: z.boolean().optional(),
        regenerate: z
          .object({
            nodeId: z.string(),
            indices: z.array(z.number().int().min(0).max(7)).min(1).max(8).optional(),
            action: z.enum(['generate', 'resume', 'save']).optional(),
            sourceRunId: z.uuid().optional(),
          })
          .optional(),
      })
      .strict(),
    true,
    (p) => workflows.start({ ...p, canvasId: target(p.canvasId), sessionId: session.id }),
  );
  define(
    'canvas_cancel',
    '停止画布工作流，已完成的产物保留。',
    z.object({ runId: z.uuid() }).strict(),
    true,
    async (p) => {
      const run = canvases.runs.get(p.runId);
      if (run.sessionId !== session.id) throw new Error('只能停止当前会话发起的工作流');
      await workflows.cancel(p.runId);
      return { stopped: true };
    },
  );
}
