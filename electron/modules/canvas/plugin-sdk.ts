import { z } from 'zod';
import type { CanvasNodePlugin, CanvasNodeContext } from './node-plugins';

export type { CanvasNodePlugin, CanvasNodeContext } from './node-plugins';
export type {
  CanvasPort,
  CanvasValueType,
  CanvasNodePluginDefinition,
  CanvasOutput,
  CanvasNode,
} from '../../../src/shared/canvas';

/** Executable extensions are owned by Cordis; return registry.register(...) as cleanup. */
export function defineCanvasPlugin(plugin: CanvasNodePlugin): CanvasNodePlugin {
  return { ...plugin, definition: { apiVersion: 1, adapter: 'native', ...plugin.definition } };
}

export interface McpNodeOptions {
  id: string;
  name: string;
  version: number;
  description?: string;
  /** A suggested tool name; the user still selects an authorized service connection. */
  tool?: string;
  arguments?: Record<string, unknown>;
}
/** MCP presets share the host's authentication, schema discovery and approval executor. */
export function createMcpNodePlugin(
  options: McpNodeOptions,
  invoke: (context: CanvasNodeContext) => ReturnType<CanvasNodePlugin['execute']>,
): CanvasNodePlugin {
  return defineCanvasPlugin({
    definition: {
      id: options.id,
      name: options.name,
      version: options.version,
      description: options.description,
      kind: 'plugin',
      adapter: 'mcp',
      cache: 'never',
      inputs: ['text', 'resource'],
      outputs: ['text', 'resource'],
      defaults: {
        config: {
          ...(options.tool ? { tool: options.tool } : {}),
          arguments: options.arguments ?? {},
        },
      },
    },
    schema: z
      .object({
        pluginId: z.string().min(1),
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.json()).optional(),
      })
      .strict(),
    execute: invoke,
  });
}
