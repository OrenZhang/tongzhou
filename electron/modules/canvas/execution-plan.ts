import type { Canvas } from '../../../src/shared/canvas';
import { canvasFailurePort } from '../../../src/shared/canvas-ports';
import { executionOrder } from './canvas';
import type { CanvasNodePlugins } from './node-plugins';

export interface CanvasLoopPlan {
  start: string;
  end: string;
  body: Set<string>;
  members: Set<string>;
}
export interface CanvasExecutionPlan {
  order: string[];
  loops: CanvasLoopPlan[];
}
export interface CanvasExecutionUnit {
  id: string;
  ids: string[];
  loop?: CanvasLoopPlan;
}

/** Loops remain acyclic in the editor: item -> body -> collect describes a scoped subgraph. */
export function planCanvasExecution(
  canvas: Canvas,
  plugins: CanvasNodePlugins,
  selected?: string[],
): CanvasExecutionPlan {
  const nodes = new Map(canvas.nodes.map((n) => [n.id, n]));
  const control = (id: string) => plugins.get(nodes.get(id)!).definition.control;
  let order = executionOrder(canvas, selected);
  const loops = new Map<string, CanvasLoopPlan>();
  for (let expanded = true; expanded; ) {
    expanded = false;
    for (const id of order) {
      if (control(id) !== 'foreach' || loops.has(id)) continue;
      const end = String(nodes.get(id)!.config?.endNodeId ?? '');
      if (!nodes.has(end) || control(end) !== 'collect' || end === id)
        throw new Error('请为逐项遍历选择配对的遍历汇总节点：' + nodes.get(id)!.title);
      const body = new Set<string>(),
        queue = canvas.edges
          .filter((e) => e.from === id && e.kind === 'dependency' && e.fromPort === 'item')
          .map((e) => e.to);
      let reachesEnd = false;
      while (queue.length) {
        const next = queue.pop()!;
        if (next === end) {
          reachesEnd = true;
          continue;
        }
        if (body.has(next)) continue;
        body.add(next);
        queue.push(
          ...canvas.edges
            .filter((e) => e.from === next && e.kind === 'dependency')
            .map((e) => e.to),
        );
      }
      if (!reachesEnd) throw new Error('遍历的当前项出口必须连接到配对汇总节点');
      const reaches = new Set([end]);
      for (const n of [...executionOrder(canvas)].reverse())
        if (canvas.edges.some((e) => e.from === n && e.kind === 'dependency' && reaches.has(e.to)))
          reaches.add(n);
      if ([...body].some((n) => !reaches.has(n)))
        throw new Error('循环体的所有执行分支都必须连接到配对汇总节点');
      const members = new Set([id, ...body, end]);
      loops.set(id, { start: id, end, body, members });
      order = executionOrder(canvas, [...new Set([...order, ...members])]);
      expanded = true;
    }
  }
  const list = [...loops.values()];
  for (const loop of list) {
    if (list.some((other) => other !== loop && other.end === loop.end))
      throw new Error('每个遍历汇总节点只能配对一个逐项遍历节点');
    for (const other of list) {
      if (other === loop) continue;
      const overlap = [...loop.members].some((id) => other.members.has(id));
      if (
        overlap &&
        ![...loop.members].every((id) => other.body.has(id)) &&
        ![...other.members].every((id) => loop.body.has(id))
      )
        throw new Error('循环体不能交叉；请使用完整嵌套或独立循环');
    }
    if (list.filter((l) => l.body.has(loop.start)).length >= 8)
      throw new Error('循环嵌套最多 8 层');
    for (const edge of canvas.edges) {
      if (loop.body.has(edge.from) && !loop.members.has(edge.to))
        throw new Error('循环体结果必须经过汇总节点后再传到循环外');
      if (edge.to === loop.end && !loop.members.has(edge.from))
        throw new Error('遍历汇总只接受配对循环体的结果');
    }
  }
  for (const id of order) {
    if (control(id) === 'collect' && !list.some((l) => l.end === id))
      throw new Error('遍历汇总节点尚未与逐项遍历配对');
    const kind = control(id);
    for (const edge of canvas.edges.filter(
      (e) => e.from === id && e.fromPort !== canvasFailurePort,
    )) {
      if (
        kind === 'condition' &&
        (!['true', 'false'].includes(edge.fromPort ?? '') || edge.kind !== 'dependency')
      )
        throw new Error('条件分支必须通过满足或不满足出口连接执行依赖');
      if (kind === 'foreach' && (edge.fromPort !== 'item' || edge.kind !== 'dependency'))
        throw new Error('遍历必须通过当前项出口连接循环体');
    }
  }
  const groups = new Map<string, string>();
  for (const id of order) {
    const key = plugins.groupKey(nodes.get(id)!);
    if (!key) continue;
    const scope =
      list.filter((l) => l.body.has(id)).sort((a, b) => a.body.size - b.body.size)[0]?.start ?? '';
    if (groups.has(key) && groups.get(key) !== scope)
      throw new Error('同一外部执行组不能跨越循环边界');
    groups.set(key, scope);
  }
  const plan = { order: plugins.plan(canvas, order), loops: list };
  // Validate collapsed dependency/reference graphs before any effects occur.
  executionUnits(canvas, plugins, plan, new Set(order));
  for (const loop of list) executionUnits(canvas, plugins, plan, loop.body);
  return plan;
}

export function executionUnits(
  canvas: Canvas,
  plugins: CanvasNodePlugins,
  plan: CanvasExecutionPlan,
  ids: Set<string>,
) {
  const units = new Map<string, CanvasExecutionUnit>(),
    owner = new Map<string, string>();
  for (const id of plan.order.filter((id) => ids.has(id))) {
    const loop = plan.loops
      .filter((l) => l.members.has(id) && [...l.members].every((n) => ids.has(n)))
      .sort((a, b) => b.members.size - a.members.size)[0];
    const node = canvas.nodes.find((n) => n.id === id)!;
    const key = loop ? 'loop:' + loop.start : (plugins.groupKey(node) ?? 'node:' + id);
    if (!units.has(key)) units.set(key, { id: key, ids: [], loop });
    units.get(key)!.ids.push(id);
    owner.set(id, key);
  }
  const dependencies = new Map([...units.keys()].map((key) => [key, new Set<string>()]));
  for (const edge of canvas.edges) {
    const from = owner.get(edge.from),
      to = owner.get(edge.to);
    if (!from || !to || from === to) continue;
    const source = canvas.nodes.find((n) => n.id === edge.from)!;
    if (
      edge.kind === 'dependency' ||
      (!plugins.get(source).definition.source && source.media?.mode !== 'existing')
    )
      dependencies.get(to)!.add(from);
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('控制节点或动态资料引用形成执行循环');
    if (done.has(id)) return;
    visiting.add(id);
    for (const upstream of dependencies.get(id)!) visit(upstream);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of units.keys()) visit(id);
  return { units: [...units.values()], dependencies, owner };
}
