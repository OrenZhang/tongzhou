import { z } from 'zod';
import { defaultCanvasPorts } from '../../../src/shared/canvas-ports';
import type { TaskOperation } from '../../core/task-contracts';
import type { Session } from '../../../src/shared/types';
import type {
  Canvas,
  CanvasExecute,
  CanvasNode,
  CanvasNodePluginDefinition,
  CanvasOutput,
  CanvasRun,
} from '../../../src/shared/canvas';

export interface CanvasNodeContext {
  node: CanvasNode;
  run: CanvasRun;
  inputs: CanvasOutput[];
  own?: CanvasOutput;
  options: CanvasExecute;
  permission: Session['permission'];
  signal: AbortSignal;
  task(
    operation?: TaskOperation,
    connection?: { providerId: string; model: string; agentId: string },
    prompt?: string,
  ): Promise<CanvasOutput>;
}
export interface CanvasGroupContext extends Omit<CanvasNodeContext, 'inputs' | 'own'> {
  nodes: CanvasNode[];
  inputs: Map<string, CanvasOutput[]>;
}
export interface CanvasNodePlugin {
  definition: Omit<CanvasNodePluginDefinition, 'configSchema'>;
  group?: {
    id: string;
    key(node: CanvasNode): string;
    execute(context: CanvasGroupContext): Promise<Record<string, CanvasOutput>>;
  };
  configKey?: 'media' | 'config';
  schema?: z.ZodType;
  execute(context: CanvasNodeContext): Promise<CanvasOutput> | CanvasOutput;
}

/** Registrations return a disposer for the owning Cordis plugin's lifecycle. No second plugin runtime. */
export class CanvasNodePlugins {
  private entries = new Map<string, CanvasNodePlugin>();
  changed: () => void = () => {};
  register(plugin: CanvasNodePlugin) {
    const id = plugin.definition.id;
    if (!/^[a-z][a-z0-9_.-]{0,119}$/.test(id)) throw new Error('节点插件 ID 无效');
    if (!Number.isInteger(plugin.definition.version) || plugin.definition.version < 1)
      throw new Error('节点插件版本无效');
    if (plugin.definition.apiVersion !== undefined && plugin.definition.apiVersion !== 1)
      throw new Error('不支持的节点插件 API 版本');
    if (plugin.definition.source && plugin.definition.adapter === 'mcp')
      throw new Error('MCP 工具不能声明为静态来源');
    if (plugin.schema) z.toJSONSchema(plugin.schema);
    if (this.entries.has(id)) throw new Error('节点插件已注册：' + id);
    this.entries.set(id, plugin);
    this.changed();
    return () => {
      if (this.entries.get(id) === plugin) {
        this.entries.delete(id);
        this.changed();
      }
    };
  }
  get(node: CanvasNode) {
    const plugin =
      this.entries.get(node.pluginId ?? node.kind) ??
      (node.definition?.adapter === 'comfyui' ? this.entries.get('comfyui') : undefined);
    if (!plugin || plugin.definition.kind !== node.kind)
      throw new Error('节点插件不可用：' + (node.pluginId ?? node.kind));
    return node.definition?.adapter === 'comfyui'
      ? { ...plugin, definition: node.definition }
      : plugin;
  }
  validate(node: CanvasNode) {
    const plugin = this.get(node);
    plugin.schema?.parse(node[plugin.configKey ?? 'config'] ?? {});
  }
  list(nodes: CanvasNode[] = []): CanvasNodePluginDefinition[] {
    const base: CanvasNodePluginDefinition[] = [...this.entries.values()]
      .filter((p) => p.definition.id !== 'comfyui')
      .map(({ definition, schema, configKey }) => ({
        ...definition,
        apiVersion: definition.apiVersion ?? 1,
        adapter: definition.adapter ?? 'native',
        ports: definition.ports ?? defaultCanvasPorts(definition),
        configKey: configKey ?? 'config',
        configSchema: schema ? z.toJSONSchema(schema) : { type: 'object', properties: {} },
      }));
    return [
      ...base,
      ...new Map(
        nodes
          .filter((n) => n.definition?.adapter === 'comfyui')
          .map((n) => [n.definition!.id, n.definition!]),
      ).values(),
    ];
  }
  groupKey(node: CanvasNode) {
    const group = this.get(node).group;
    return group ? JSON.stringify([group.id, group.key(node)]) : undefined;
  }
  plan(canvas: Canvas, order: string[]) {
    const units = new Map(
      order.map((id) => [
        id,
        this.groupKey(canvas.nodes.find((n) => n.id === id)!) ?? `node:${id}`,
      ]),
    );
    const groups = new Map<string, string[]>();
    for (const id of order) {
      const unit = units.get(id)!;
      groups.set(unit, [...(groups.get(unit) ?? []), id]);
    }
    const done = new Set<string>(),
      visiting = new Set<string>(),
      result: string[] = [];
    const visit = (key: string) => {
      if (done.has(key)) return;
      if (visiting.has(key))
        throw new Error('节点组与本地节点交错形成执行循环，请在输出文件边界拆分工作流');
      visiting.add(key);
      for (const edge of canvas.edges) {
        const from = units.get(edge.from),
          to = units.get(edge.to);
        if (edge.kind === 'dependency' && from && to === key && from !== key) visit(from);
      }
      visiting.delete(key);
      done.add(key);
      result.push(...groups.get(key)!);
    };
    for (const key of groups.keys()) visit(key);
    return result;
  }
  async executeGroup(context: CanvasGroupContext) {
    context.signal.throwIfAborted();
    const key = this.groupKey(context.node);
    if (!key || !context.nodes.length) throw new Error('节点组不可用');
    for (const node of context.nodes) {
      this.validate(node);
      if (this.groupKey(node) !== key) throw new Error('节点不属于当前执行组');
      const definition = this.get(node).definition,
        frozen = context.run.nodes[node.id]?.plugin;
      if (frozen && (frozen.id !== definition.id || frozen.version !== definition.version))
        throw new Error('节点插件版本已变化，请重新启动工作流');
    }
    const outputs = await this.get(context.node).group!.execute(context);
    context.signal.throwIfAborted();
    for (const node of context.nodes) {
      const output = outputs[node.id];
      if (typeof output?.text !== 'string' || !Array.isArray(output.resources))
        throw new Error('节点插件未返回有效的输出');
    }
    return outputs;
  }
  async execute(context: CanvasNodeContext) {
    context.signal.throwIfAborted();
    this.validate(context.node);
    const plugin = this.get(context.node),
      frozen = context.run.nodes[context.node.id]?.plugin;
    if (
      frozen &&
      (frozen.id !== plugin.definition.id || frozen.version !== plugin.definition.version)
    )
      throw new Error('节点插件版本已变化，请重新启动工作流');
    const key = plugin.configKey ?? 'config';
    const node =
      plugin.schema && !(key === 'media' && context.node.media === undefined)
        ? { ...context.node, [key]: plugin.schema.parse(context.node[key] ?? {}) }
        : context.node;
    const result = await plugin.execute({ ...context, node });
    context.signal.throwIfAborted();
    if (typeof result?.text !== 'string' || !Array.isArray(result.resources))
      throw new Error('节点插件未返回有效的输出');
    return result;
  }
}
