import { describe, it, expect } from 'vitest';
import { parseSplitOutput, splitConfigSchema } from '../../../electron/modules/canvas/split-plugin';
import {
  connectCanvasPorts,
  routeCanvasOutput,
  defaultSplitCategories,
} from '../../../src/shared/canvas-ports';
import { materializeSplitItems } from '../../../src/shared/canvas-editing';
import type { Canvas, CanvasNode } from '../../../src/shared/canvas';

const node = (id: string, kind: CanvasNode['kind']): CanvasNode => ({
  id,
  kind,
  title: id,
  x: 0,
  y: 0,
});
const graph: Canvas = {
  id: 'canvas',
  title: 'test',
  version: 1,
  updatedAt: 1,
  nodes: [node('text', 'text'), node('image', 'image'), node('video', 'video')],
  edges: [],
  selection: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};
describe('canvas typed ports and structured splitting', () => {
  it('rejects wrong media connections, duplicates and cycles while accepting compatible ports', () => {
    const edge = {
      id: 'a',
      from: 'image',
      to: 'video',
      kind: 'dependency' as const,
      fromPort: 'result',
      toPort: 'reference',
    };
    const linked = connectCanvasPorts(graph, edge, []);
    expect(linked.edges).toHaveLength(1);
    expect(() => connectCanvasPorts(linked, { ...edge, id: 'b' }, [])).toThrow('已经存在');
    expect(() => connectCanvasPorts(graph, { ...edge, toPort: 'prompt' }, [])).toThrow(
      '类型不兼容',
    );
    expect(() =>
      connectCanvasPorts(linked, { id: 'c', from: 'video', to: 'image', kind: 'dependency' }, []),
    ).toThrow('循环');
  });
  it('keeps custom categories isolated, supports empty outputs and rejects malformed model replies', () => {
    const categories = [{ id: 'dialogue', label: '对白', instruction: '提取对话' }];
    const output = parseSplitOutput(
      '```json\n{"dialogue":[{"name":"开场","description":"你好"}]}\n```',
      categories,
    );
    expect(
      routeCanvasOutput(output, {
        id: 'e',
        from: 'a',
        to: 'b',
        kind: 'dependency',
        fromPort: 'dialogue',
        toPort: 'prompt',
      }),
    ).toEqual({ text: '开场\n你好', resources: [], inputPort: 'prompt' });
    expect(parseSplitOutput('{"dialogue":[]}', categories).ports?.dialogue.items).toEqual([]);
    for (const value of ['not JSON', '{}', '{"dialogue":"bad"}', '{"dialogue":[],"extra":[]}'])
      expect(() => parseSplitOutput(value, categories)).toThrow();
    expect(() =>
      routeCanvasOutput(output, {
        id: 'e',
        from: 'a',
        to: 'b',
        kind: 'dependency',
        fromPort: 'scenes',
      }),
    ).toThrow('缺少输出端口');
    expect(() => splitConfigSchema.parse({ categories: [categories[0], categories[0]] })).toThrow();
    expect(splitConfigSchema.parse({}).categories).toEqual(defaultSplitCategories);
  });
  it('materializes editable text nodes without mutating the source graph and enforces capacity', () => {
    const items = [
      { name: '人物一', description: '蓝色长衫' },
      { name: '人物二', description: '白色衣服' },
    ];
    const result = materializeSplitItems(graph, graph.nodes[0], '人物', items);
    expect(result.nodes.slice(-2).map((n) => n.text)).toEqual([
      '人物一\n蓝色长衫',
      '人物二\n白色衣服',
    ]);
    expect(result.selection).toHaveLength(2);
    expect(graph.nodes).toHaveLength(3);
    expect(() =>
      materializeSplitItems(
        { ...graph, nodes: Array(199).fill(graph.nodes[0]) },
        graph.nodes[0],
        '人物',
        items,
      ),
    ).toThrow('200');
  });
});
