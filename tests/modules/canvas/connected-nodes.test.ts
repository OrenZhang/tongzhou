import { describe, it, expect } from 'vitest';
import { appendConnectedCanvasNode } from '../../../src/shared/canvas-editing';
import type { Canvas, CanvasNodePluginDefinition } from '../../../src/shared/canvas';

const image: CanvasNodePluginDefinition = {
  id: 'image',
  name: '图片生成',
  kind: 'image',
  version: 1,
  inputs: ['text', 'image'],
  outputs: ['image'],
  configSchema: {},
};
const graph: Canvas = {
  id: 'c',
  title: 'test',
  version: 1,
  updatedAt: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  selection: [],
  nodes: [
    { id: 'a', kind: 'text', title: '原文', x: 0, y: 0 },
    { id: 'occupied', kind: 'text', title: '占用', x: 340, y: 0 },
  ],
  edges: [],
};
describe('create a connected downstream node', () => {
  it('adds typed edges and media defaults atomically without overlapping or mutating the source', () => {
    const next = appendConnectedCanvasNode(graph, 'a', 'result', image, 'prompt', [image]);
    const node = next.nodes.at(-1)!;
    expect(next.selection).toEqual([node.id]);
    expect(node.y).toBeGreaterThan(180);
    expect(node.media).toMatchObject({
      count: 1,
      mode: 'text',
      destination: { kind: 'artifacts' },
    });
    expect(next.edges[0]).toMatchObject({
      from: 'a',
      fromPort: 'result',
      to: node.id,
      toPort: 'prompt',
      kind: 'dependency',
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(0);
  });
  it('rejects incompatible inputs and full canvases before creating a partial edit', () => {
    const text: CanvasNodePluginDefinition = {
      id: 'text',
      name: '文本',
      kind: 'text',
      version: 1,
      inputs: [],
      outputs: ['text'],
      configSchema: {},
    };
    expect(() =>
      appendConnectedCanvasNode(graph, 'a', 'result', image, 'reference', [text, image]),
    ).toThrow('类型不兼容');
    expect(() =>
      appendConnectedCanvasNode(
        {
          ...graph,
          nodes: Array.from({ length: 200 }, (_, i) => ({ ...graph.nodes[0], id: String(i) })),
        },
        '0',
        'result',
        image,
        'prompt',
        [image],
      ),
    ).toThrow('200');
    expect(graph.nodes).toHaveLength(2);
  });
});
