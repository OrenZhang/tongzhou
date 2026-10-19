import type { CanvasMedia } from './canvas';
import type { PluginTool } from './types';

export const mediaFieldNames = {
  prompt: ['prompt', 'text', 'description'],
  model: ['model', 'model_name'],
  voice: ['voice_id', 'voice'],
  speed: ['speed', 'speech_rate'],
  aspectRatio: ['aspect_ratio', 'ratio'],
  resolution: ['resolution'],
  duration: ['duration', 'seconds'],
  count: ['n', 'count', 'num_images', 'number_of_images'],
  reference: [
    'input_urls',
    'image_urls',
    'reference_images',
    'image_path',
    'subject_reference',
    'image_url',
    'input_image_url',
  ],
  firstFrame: ['first_frame_image', 'first_frame_image_url', 'input_image_url', 'image_url'],
  lastFrame: ['last_frame_image', 'last_frame_image_url', 'end_image_url'],
};

export const mediaManagedFields = new Set([
  ...Object.values(mediaFieldNames).flat(),
  'output_directory',
  'output_dir',
  'output_file',
  'save_path',
]);

export function mediaExtraSchema(tool: PluginTool) {
  const properties = Object.fromEntries(
    Object.entries(tool.inputSchema.properties ?? {}).filter(
      ([key]) => !mediaManagedFields.has(key),
    ),
  );
  return {
    ...tool.inputSchema,
    properties,
    required: (tool.inputSchema.required ?? []).filter((key: string) => key in properties),
  };
}

/** Preserve supported user choices; model identifiers and extension parameters are tool-specific. */
export function switchCanvasMediaTool(
  current: CanvasMedia,
  pluginId: string | undefined,
  tool?: PluginTool,
) {
  const fields = tool?.inputSchema.properties ?? {};
  const reset: string[] = [];
  const supported = (value: unknown, schema: Record<string, any> | undefined) => {
    if (value === undefined || !schema) return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    if (schema.type === 'string' && typeof value !== 'string') return false;
    if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (schema.type === 'integer' && !Number.isInteger(value)) return false;
    }
    if (
      typeof value === 'number' &&
      (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))
    )
      return false;
    return true;
  };
  const keep = (
    key: 'model' | 'aspectRatio' | 'resolution' | 'duration' | 'voice' | 'speed',
    names: string[],
  ) => {
    const schema = names.map((name) => fields[name]).find(Boolean);
    const portable = key !== 'model' || current.pluginId === pluginId || !!schema?.enum;
    if (portable && supported(current[key], schema)) return current[key];
    if (current[key] !== undefined) reset.push(key);
    return key === 'model' ? (schema?.default ?? schema?.enum?.[0]) : undefined;
  };
  let mode = current.mode ?? 'text';
  const reference = mediaFieldNames.reference.some((key) => fields[key]);
  const first = mediaFieldNames.firstFrame.some((key) => fields[key]);
  const last = mediaFieldNames.lastFrame.some((key) => fields[key]);
  if (
    (mode === 'reference' && !reference) ||
    (mode === 'first-frame' && !first) ||
    (mode === 'frames' && (!first || !last))
  ) {
    mode = 'text';
    reset.push('mode');
  }
  const sameTool = current.pluginId === pluginId && current.tool === tool?.name;
  if (!sameTool && Object.keys(current.parameters ?? {}).length) reset.push('parameters');
  const media: CanvasMedia = {
    ...current,
    pluginId,
    tool: tool?.name,
    mode,
    model: keep('model', mediaFieldNames.model) as string | undefined,
    aspectRatio: keep('aspectRatio', mediaFieldNames.aspectRatio) as string | undefined,
    resolution: keep('resolution', mediaFieldNames.resolution) as string | undefined,
    duration: keep('duration', mediaFieldNames.duration) as number | undefined,
    voice: keep('voice', mediaFieldNames.voice) as string | undefined,
    speed: keep('speed', mediaFieldNames.speed) as number | undefined,
    parameters: sameTool ? current.parameters : undefined,
  };
  return { media, reset };
}
