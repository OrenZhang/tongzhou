import type { PluginConfig, PluginTool, Provider } from './types';
import { canvasMediaTools, type CanvasMedia } from './canvas';
import { mediaFieldNames } from './canvas-media-settings';

export const modelCapabilities = {
  text: '文本生成',
  vision: '图片理解',
  image: '图片生成',
  imageEdit: '参考图编辑',
  video: '视频生成',
  imageToVideo: '图生视频',
  videoFrames: '视频首尾帧',
  audio: '音频生成',
  transcription: '语音识别',
} as const;
export type ModelCapability = keyof typeof modelCapabilities;
export type MediaKind = 'image' | 'video' | 'audio';
export interface ModelMediaBinding {
  pluginId: string;
  tool: string;
  /** Explicit tool-side identifier; omitted means use the configured model ID. */
  model?: string;
}
export interface ModelCapabilities {
  capabilities: ModelCapability[];
  bindings?: Partial<Record<MediaKind, ModelMediaBinding>>;
}

export function modelCapabilityProfile(provider: Provider, model: string) {
  return provider.modelCapabilities && Object.hasOwn(provider.modelCapabilities, model)
    ? provider.modelCapabilities[model]
    : undefined;
}

/** Unclassified legacy models remain available in conversations. Never infer generation from names. */
export function supportsConversation(provider: Provider, model: string) {
  const entry = modelCapabilityProfile(provider, model);
  return !entry || entry.capabilities.includes('text');
}
export function conversationModels(provider?: Provider) {
  return provider?.models.filter((model) => supportsConversation(provider, model)) ?? [];
}

/** Use only exact model IDs advertised by tools. Ambiguous matches require an explicit binding. */
export function discoverMediaCapabilities(
  model: string,
  plugins: PluginConfig[],
): ModelCapabilities | undefined {
  const capabilities: ModelCapability[] = [];
  const bindings: ModelCapabilities['bindings'] = {};
  for (const kind of ['image', 'video', 'audio'] as const) {
    const matches = plugins
      .filter((p) => p.enabled)
      .flatMap((plugin) =>
        canvasMediaTools(plugin, kind)
          .filter((tool) =>
            mediaFieldNames.model.some((key) =>
              tool.inputSchema.properties?.[key]?.enum?.includes(model),
            ),
          )
          .map((tool) => ({ pluginId: plugin.id, tool: tool.name })),
      );
    if (matches.length) capabilities.push(kind);
    if (matches.length === 1) bindings[kind] = matches[0];
  }
  return capabilities.length ? { capabilities, bindings } : undefined;
}
export function mediaModeCapability(kind: MediaKind, mode?: CanvasMedia['mode']): ModelCapability {
  if (kind === 'image' && mode === 'reference') return 'imageEdit';
  if (kind === 'video' && mode === 'frames') return 'videoFrames';
  if (kind === 'video' && (mode === 'reference' || mode === 'first-frame')) return 'imageToVideo';
  return kind;
}
export function toolSupportsMediaMode(tool: PluginTool, mode?: CanvasMedia['mode']) {
  const fields = tool.inputSchema.properties ?? {};
  const has = (keys: string[]) => keys.some((key) => fields[key]);
  if (mode === 'reference') return has(mediaFieldNames.reference);
  if (mode === 'first-frame') return has(mediaFieldNames.firstFrame);
  if (mode === 'frames') return has(mediaFieldNames.firstFrame) && has(mediaFieldNames.lastFrame);
  return true;
}

export function mediaModelCatalog(
  providers: Provider[],
  plugins: PluginConfig[],
  kind: MediaKind,
  mode?: CanvasMedia['mode'],
) {
  return providers
    .filter((p) => p.enabled !== false)
    .flatMap((provider) =>
      provider.models.flatMap((model) => {
        const config = modelCapabilityProfile(provider, model);
        if (!config?.capabilities.includes(kind)) return [];
        const binding = config.bindings?.[kind];
        const plugin = plugins.find((p) => p.id === binding?.pluginId && p.enabled);
        const tool = plugin && canvasMediaTools(plugin, kind).find((t) => t.name === binding?.tool);
        const wireModel = binding?.model ?? model;
        const field =
          tool &&
          mediaFieldNames.model.map((key) => tool.inputSchema.properties?.[key]).find(Boolean);
        const issue = !binding
          ? '尚未绑定生成工具'
          : !tool
            ? '生成工具不可用，请启用并刷新插件'
            : !field || (field.enum && !field.enum.includes(wireModel))
              ? '工具不接受此模型 ID'
              : !config.capabilities.includes(mediaModeCapability(kind, mode)) ||
                  !toolSupportsMediaMode(tool, mode)
                ? '模型或工具不支持当前生成模式'
                : undefined;
        return [
          {
            providerId: provider.id,
            capabilities: config.capabilities,
            model,
            name: provider.name,
            label: provider.modelLabels?.[model] ?? model,
            binding,
            tool,
            wireModel,
            issue,
          },
        ];
      }),
    );
}

/** A saved selection must still refer to the same executable binding. Never silently reroute a retry. */
export function validateMediaModel(
  media: CanvasMedia,
  kind: MediaKind,
  providers: Provider[],
  plugins: PluginConfig[],
) {
  if (!media.modelProviderId) return;
  const choice = mediaModelCatalog(providers, plugins, kind, media.mode).find(
    (c) => c.providerId === media.modelProviderId && c.model === media.registeredModel,
  );
  if (!choice) throw new Error('所选生成模型已移除、停用或未标记对应能力');
  if (choice.issue) throw new Error(choice.issue);
  if (
    choice.binding?.pluginId !== media.pluginId ||
    choice.binding?.tool !== media.tool ||
    choice.wireModel !== media.model
  )
    throw new Error('模型的生成工具绑定已变化，请重新选择模型');
}
