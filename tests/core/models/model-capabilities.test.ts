import { describe, it, expect } from 'vitest';
import {
  conversationModels,
  mediaModelCatalog,
  validateMediaModel,
  discoverMediaCapabilities,
} from '../../../src/shared/model-capabilities';
import { providerSchema } from '../../../electron/services/storage/validation';
import { routeModel } from '../../../src/shared/model-protocol';
import { switchCanvasMediaTool } from '../../../src/shared/canvas-media-settings';
import type { Provider, PluginConfig } from '../../../src/shared/types';

const tool = {
  name: 'image_generation',
  description: 'image generation',
  inputSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', enum: ['paint-v1'] },
      prompt: { type: 'string' },
      reference_images: { type: 'array' },
    },
  },
};
const plugin: PluginConfig = {
  id: 'media',
  name: 'Media',
  transport: 'stdio',
  command: 'node',
  args: [],
  url: '',
  enabled: true,
  readOnlyTools: [],
  catalog: [tool],
};
const provider: Provider = {
  id: 'test',
  name: 'Test',
  protocol: 'openai-chat',
  baseUrl: 'https://example.com/v1',
  auth: 'none',
  models: ['chat', 'vision', 'paint'],
  maxOutputTokens: 1024,
  contextChars: 0,
  modelCapabilities: {
    vision: { capabilities: ['text', 'vision'] },
    paint: {
      capabilities: ['image'],
      bindings: { image: { pluginId: 'media', tool: tool.name, model: 'paint-v1' } },
    },
  },
};
const media = {
  modelProviderId: 'test',
  registeredModel: 'paint',
  pluginId: 'media',
  tool: tool.name,
  model: 'paint-v1',
};
describe('model capabilities and executable media bindings', () => {
  it('discovers exact catalog IDs without guessing from names or choosing ambiguous services', () => {
    expect(discoverMediaCapabilities('paint-v1', [plugin])?.bindings?.image?.pluginId).toBe(
      'media',
    );
    expect(
      discoverMediaCapabilities('paint-v1', [plugin, { ...plugin, id: 'other' }])?.bindings?.image,
    ).toBeUndefined();
    expect(discoverMediaCapabilities('image-super-model', [plugin])).toBeUndefined();
    expect(discoverMediaCapabilities('paint-v1', [{ ...plugin, enabled: false }])).toBeUndefined();
  });
  it('retains unknown legacy chat models but excludes explicitly media-only models', () => {
    expect(conversationModels(provider)).toEqual(['chat', 'vision']);
    expect(conversationModels()).toEqual([]);
    expect(
      conversationModels({
        ...provider,
        models: ['constructor', 'toString'],
        modelCapabilities: {},
      }),
    ).toEqual(['constructor', 'toString']);
    expect(mediaModelCatalog([provider], [plugin], 'image')).toHaveLength(1);
    expect(mediaModelCatalog([provider], [plugin], 'video')).toEqual([]);
  });
  it('persists capabilities through provider validation and rejects unsupported keys', () => {
    expect(providerSchema.parse(provider).modelCapabilities).toEqual(provider.modelCapabilities);
    expect(() =>
      providerSchema.parse({
        ...provider,
        modelCapabilities: { paint: { capabilities: ['magic'] } },
      }),
    ).toThrow();
    expect(() =>
      providerSchema.parse({
        ...provider,
        modelCapabilities: { paint: { capabilities: ['image'], bindings: { script: {} } } },
      }),
    ).toThrow();
  });
  it('uses the explicit tool model alias and validates enabled tool and model enums', () => {
    expect(() => validateMediaModel(media, 'image', [provider], [plugin])).not.toThrow();
    expect(() =>
      validateMediaModel(media, 'image', [provider], [{ ...plugin, enabled: false }]),
    ).toThrow('不可用');
    const invalid = structuredClone(provider);
    invalid.modelCapabilities!.paint.bindings!.image!.model = 'wrong-model';
    expect(mediaModelCatalog([invalid], [plugin], 'image')[0].issue).toContain('模型 ID');
  });
  it('requires both tool support and model capability for reference generation', () => {
    expect(() =>
      validateMediaModel({ ...media, mode: 'reference' }, 'image', [provider], [plugin]),
    ).toThrow('生成模式');
    const edit = structuredClone(provider);
    edit.modelCapabilities!.paint.capabilities.push('imageEdit');
    expect(() =>
      validateMediaModel({ ...media, mode: 'reference' }, 'image', [edit], [plugin]),
    ).not.toThrow();
    const noRef = {
      ...plugin,
      catalog: [
        { ...tool, inputSchema: { properties: { model: tool.inputSchema.properties.model } } },
      ],
    };
    expect(() =>
      validateMediaModel({ ...media, mode: 'reference' }, 'image', [edit], [noRef]),
    ).toThrow('生成模式');
  });
  it('rejects a changed binding instead of silently redirecting a saved run', () => {
    const changed = structuredClone(provider);
    changed.modelCapabilities!.paint.bindings!.image!.pluginId = 'other';
    expect(() =>
      validateMediaModel(media, 'image', [changed], [{ ...plugin, id: 'other' }]),
    ).toThrow('绑定已变化');
    expect(() =>
      validateMediaModel(media, 'image', [{ ...provider, enabled: false }], [plugin]),
    ).toThrow('已移除');
  });
  it('keeps unregistered plugin workflows valid and clears registration on manual tool changes', () => {
    expect(() =>
      validateMediaModel({ pluginId: 'media', tool: tool.name }, 'image', [], []),
    ).not.toThrow();
    const switched = switchCanvasMediaTool(media, plugin.id, tool).media;
    expect(switched.modelProviderId).toBeUndefined();
    expect(switched.registeredModel).toBeUndefined();
  });
  it('does not route a conversation to an image generator even with a legacy pool rule', () => {
    const owner = {
      ...provider,
      modelPool: [
        {
          providerId: provider.id,
          model: 'paint',
          scene: 'any' as const,
          stage: 'any' as const,
          images: true,
        },
        {
          providerId: provider.id,
          model: 'vision',
          scene: 'any' as const,
          stage: 'any' as const,
          images: true,
        },
      ],
    };
    expect(routeModel(owner, [provider], { prompt: 'describe', images: true }).model).toBe(
      'vision',
    );
  });
});
