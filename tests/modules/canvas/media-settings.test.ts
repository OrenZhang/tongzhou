import { describe, expect, it } from 'vitest';
import { mediaExtraSchema, switchCanvasMediaTool } from '../../../src/shared/canvas-media-settings';
import type { PluginTool } from '../../../src/shared/types';

const tool: PluginTool = {
  name: 'generate_video',
  description: 'Video',
  inputSchema: {
    type: 'object',
    properties: {
      model: { enum: ['v2'] },
      ratio: { enum: ['16:9', '9:16'] },
      resolution: { enum: ['720P', '1080P'] },
      seconds: { type: 'integer', minimum: 2, maximum: 10 },
      first_frame_image_url: { type: 'string' },
      last_frame_image_url: { type: 'string' },
      seed: { type: 'integer' },
    },
    required: ['model', 'seed'],
  },
};
describe('media tool changes', () => {
  it('keeps compatible settings across providers and schema aliases without losing assets', () => {
    const frame = { kind: 'artifact' as const, id: 'image' };
    const { media, reset } = switchCanvasMediaTool(
      {
        pluginId: 'old',
        tool: 'old',
        model: 'v2',
        aspectRatio: '16:9',
        resolution: '1080P',
        duration: 5,
        count: 3,
        mode: 'frames',
        firstFrame: frame,
        destination: { kind: 'artifacts' },
      },
      'new',
      tool,
    );
    expect(media).toMatchObject({
      pluginId: 'new',
      tool: 'generate_video',
      model: 'v2',
      aspectRatio: '16:9',
      resolution: '1080P',
      duration: 5,
      count: 3,
      mode: 'frames',
      firstFrame: frame,
      destination: { kind: 'artifacts' },
    });
    expect(reset).toEqual([]);
  });
  it('clears incompatible values and tool-specific extras, keeping the input assets', () => {
    const { media, reset } = switchCanvasMediaTool(
      {
        pluginId: 'old',
        model: 'v1',
        aspectRatio: '1:1',
        resolution: '4K',
        duration: 20,
        parameters: { seed: 42 },
        referenceImages: [{ kind: 'artifact', id: 'ref' }],
      },
      'new',
      tool,
    );
    expect(media.model).toBe('v2');
    expect(media.aspectRatio).toBeUndefined();
    expect(media.resolution).toBeUndefined();
    expect(media.duration).toBeUndefined();
    expect(media.parameters).toBeUndefined();
    expect(media.referenceImages).toHaveLength(1);
    expect(reset).toEqual(
      expect.arrayContaining(['model', 'aspectRatio', 'resolution', 'duration', 'parameters']),
    );
  });
  it('does not erase extension parameters when reselecting the same tool', () => {
    expect(
      switchCanvasMediaTool({ pluginId: 'p', tool: tool.name, parameters: { seed: 42 } }, 'p', tool)
        .media.parameters,
    ).toEqual({ seed: 42 });
  });
  it('advanced settings contain only unmanaged fields and their requirements', () => {
    const schema = mediaExtraSchema(tool);
    expect(Object.keys(schema.properties)).toEqual(['seed']);
    expect(schema.required).toEqual(['seed']);
  });
});
