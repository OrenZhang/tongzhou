import { z } from 'zod';
import type { TaskOperation } from '../../core/task-contracts';
import type { Session } from '../../../src/shared/types';
import type {
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
  ): Promise<CanvasOutput>;
}
export interface CanvasNodePlugin {
  definition: Omit<CanvasNodePluginDefinition, 'configSchema'>;
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
    const plugin = this.entries.get(node.pluginId ?? node.kind);
    if (!plugin || plugin.definition.kind !== node.kind)
      throw new Error('节点插件不可用：' + (node.pluginId ?? node.kind));
    return plugin;
  }
  validate(node: CanvasNode) {
    const plugin = this.get(node);
    plugin.schema?.parse(node[plugin.configKey ?? 'config'] ?? {});
  }
  list(): CanvasNodePluginDefinition[] {
    return [...this.entries.values()].map(({ definition, schema, configKey }) => ({
      ...definition,
      configKey: configKey ?? 'config',
      configSchema: schema ? z.toJSONSchema(schema) : { type: 'object', properties: {} },
    }));
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
