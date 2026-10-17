import type { Canvas, CanvasNode, CanvasNodePluginDefinition } from './canvas';
import { connectCanvasPorts } from './canvas-ports';

export function pluginCanvasNode(definition: CanvasNodePluginDefinition): CanvasNode {
  return {
    id: crypto.randomUUID(),
    kind: definition.kind,
    pluginId: definition.id,
    title: definition.name,
    x: 0,
    y: 0,
    ...structuredClone(definition.defaults ?? {}),
    ...(definition.kind === 'save' ? { libraryId: 'default' } : {}),
    ...(['image', 'video', 'audio'].includes(definition.kind)
      ? { media: { count: 1, mode: 'text' as const, destination: { kind: 'artifacts' as const } } }
      : {}),
  };
}

/** Create and connect in one history step, using the same validation as dragged edges. */
export function appendConnectedCanvasNode(
  canvas: Canvas,
  from: string,
  fromPort: string,
  definition: CanvasNodePluginDefinition,
  toPort: string,
  plugins: CanvasNodePluginDefinition[],
): Canvas {
  if (canvas.nodes.length >= 200) throw new Error('画布最多支持 200 个节点');
  const source = canvas.nodes.find((n) => n.id === from);
  if (!source) throw new Error('起点节点已删除');
  const node = pluginCanvasNode(definition);
  node.x = source.x + (source.width ?? 240) + 100;
  node.y = source.y;
  while (
    canvas.nodes.some(
      (n) =>
        node.x < n.x + (n.width ?? 240) + 24 &&
        node.x + (node.width ?? 240) + 24 > n.x &&
        node.y < n.y + (n.height ?? 180) + 24 &&
        node.y + (node.height ?? 180) + 24 > n.y,
    )
  )
    node.y += (node.height ?? 180) + 40;
  if (node.x > 100000 || node.y > 100000) throw new Error('新节点超出画布范围，请先移动起点节点');
  return connectCanvasPorts(
    { ...canvas, nodes: [...canvas.nodes, node], selection: [node.id] },
    { id: crypto.randomUUID(), from, fromPort, to: node.id, toPort, kind: 'dependency' },
    plugins,
  );
}

export function materializeSplitItems(
  canvas: Canvas,
  source: CanvasNode,
  label: string,
  items: { name: string; description: string }[],
): Canvas {
  if (!items.length) return canvas;
  if (canvas.nodes.length + items.length > 200)
    throw new Error('展开后超过 200 个节点，请逐项插入或另建画布');
  const x = Math.max(...canvas.nodes.map((n) => n.x + (n.width ?? 240))) + 80;
  const group = `${label.slice(0, 60)} ${crypto.randomUUID().slice(0, 8)}`;
  const nodes = items.map(
    (item, i): CanvasNode => ({
      id: crypto.randomUUID(),
      kind: 'text',
      title: item.name,
      text: item.name + '\n' + item.description,
      x: x + (i % 3) * 320,
      y: source.y + Math.floor(i / 3) * 240,
      width: 280,
      height: 200,
      group,
    }),
  );
  if (nodes.some((n) => n.x > 100000 || n.y > 100000))
    throw new Error('新节点超出画布坐标范围，请先移动原节点');
  return { ...canvas, nodes: [...canvas.nodes, ...nodes], selection: nodes.map((n) => n.id) };
}

export function nodeBounds(nodes: CanvasNode[]) {
  if (!nodes.length) return { x: 0, y: 0, width: 600, height: 400 };
  const x = Math.min(...nodes.map((n) => n.x)),
    y = Math.min(...nodes.map((n) => n.y));
  return {
    x,
    y,
    width: Math.max(...nodes.map((n) => n.x + (n.width ?? 240))) - x,
    height: Math.max(...nodes.map((n) => n.y + (n.height ?? 180))) - y,
  };
}
export function duplicateSelection(
  canvas: Canvas,
  id: () => string = () => crypto.randomUUID(),
): Canvas {
  const selected = canvas.nodes.filter((n) => canvas.selection.includes(n.id));
  if (canvas.nodes.length + selected.length > 200) throw new Error('画布最多支持 200 个节点');
  const ids = new Map(selected.map((n) => [n.id, id()]));
  const groups = new Map(
    selected.filter((n) => n.group).map((n) => [n.group!, `分组 ${id().slice(0, 8)}`]),
  );
  const edges = canvas.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ ...e, id: id(), from: ids.get(e.from)!, to: ids.get(e.to)! }));
  if (canvas.edges.length + edges.length > 800) throw new Error('画布最多支持 800 条连线');
  return {
    ...canvas,
    nodes: [
      ...canvas.nodes,
      ...selected.map((n) => ({
        ...structuredClone(n),
        id: ids.get(n.id)!,
        x: Math.min(100000, n.x + 40),
        y: Math.min(100000, n.y + 40),
        group: n.group ? groups.get(n.group) : undefined,
      })),
    ],
    edges: [...canvas.edges, ...edges],
    selection: [...ids.values()],
  };
}
export function alignSelection(canvas: Canvas, mode: 'left' | 'top' | 'horizontal'): Canvas {
  const nodes = canvas.nodes
    .filter((n) => canvas.selection.includes(n.id))
    .sort((a, b) => a.x - b.x);
  if (nodes.length < 2) return canvas;
  const bounds = nodeBounds(nodes);
  const gap =
    nodes.length > 2
      ? (bounds.width - nodes.reduce((s, n) => s + (n.width ?? 240), 0)) / (nodes.length - 1)
      : 24;
  let x = bounds.x;
  const changes = new Map(
    nodes.map((n) => {
      const next = {
        ...n,
        x: mode === 'left' ? bounds.x : mode === 'horizontal' ? x : n.x,
        y: mode === 'top' ? bounds.y : n.y,
      };
      x += (n.width ?? 240) + gap;
      return [n.id, next];
    }),
  );
  return { ...canvas, nodes: canvas.nodes.map((n) => changes.get(n.id) ?? n) };
}
