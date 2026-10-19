import type {
  Canvas,
  CanvasEdge,
  CanvasNode,
  CanvasNodePluginDefinition,
  CanvasOutput,
  CanvasPort,
  CanvasValueType,
} from './canvas';

export const splitPluginId = 'content.split';
export interface SplitCategory {
  id: string;
  label: string;
  instruction: string;
}
export const defaultSplitCategories: SplitCategory[] = [
  {
    id: 'characters',
    label: '人物',
    instruction: '提取姓名、外貌、服装、性格和身份；保持原文一致，不编造缺失信息。',
  },
  {
    id: 'scenes',
    label: '场景',
    instruction: '提取地点、时代、环境、光照与氛围，形成可用于画面生成的文字描述。',
  },
  { id: 'props', label: '物品', instruction: '提取重要物品的名称、材质、外观与用途。' },
];
export function splitCategories(node: CanvasNode): SplitCategory[] {
  return Array.isArray(node.config?.categories)
    ? node.config.categories.filter(
        (row): row is unknown & SplitCategory =>
          !!row &&
          typeof row === 'object' &&
          typeof (row as SplitCategory).id === 'string' &&
          typeof (row as SplitCategory).label === 'string' &&
          typeof (row as SplitCategory).instruction === 'string',
      )
    : defaultSplitCategories;
}
const all: CanvasValueType[] = ['text', 'image', 'video', 'audio', 'resource'];
const port = (
  id: string,
  label: string,
  types: CanvasValueType[],
  description?: string,
): CanvasPort => ({ id, label, types, description });
export function defaultCanvasPorts(
  def: Pick<CanvasNodePluginDefinition, 'kind' | 'inputs' | 'outputs' | 'id'>,
) {
  if (['image', 'video', 'audio'].includes(def.kind))
    return {
      inputs: [
        port('prompt', '提示词', ['text']),
        ...(def.kind !== 'audio' ? [port('reference', '参考图片', ['image'])] : []),
        ...(def.kind === 'video'
          ? [port('firstFrame', '首帧', ['image']), port('lastFrame', '尾帧', ['image'])]
          : []),
      ],
      outputs: [
        port(
          'result',
          def.kind === 'image' ? '生成图片' : def.kind === 'video' ? '生成视频' : '生成音频',
          [def.kind as CanvasValueType],
        ),
      ],
    };
  return {
    inputs: def.inputs.length
      ? [
          port(
            'context',
            def.kind === 'save' ? '待保存内容' : '输入内容',
            def.kind === 'agent' || def.kind === 'save' || def.id === 'plugin' ? all : def.inputs,
          ),
        ]
      : [],
    outputs: [port('result', def.kind === 'text' ? '文本' : '结果', def.outputs)],
  };
}
export function canvasPorts(
  node: CanvasNode,
  definition?: Pick<
    CanvasNodePluginDefinition,
    'ports' | 'dynamicOutputs' | 'inputs' | 'outputs' | 'kind' | 'id'
  >,
) {
  const base =
    (definition ?? node.definition)?.ports ??
    defaultCanvasPorts(
      definition ??
        node.definition ?? {
          id: node.pluginId ?? node.kind,
          kind: node.kind,
          inputs: ['text', 'resource'],
          outputs: ['text', 'resource'],
        },
    );
  if (definition?.dynamicOutputs === 'categories' || node.pluginId === splitPluginId)
    return {
      inputs: [port('context', '原文内容', ['text', 'resource'])],
      outputs: splitCategories(node).map((c) => port(c.id, c.label, ['text'], c.instruction)),
    };
  return base;
}
export function validateCanvasPorts(
  edge: CanvasEdge,
  source: CanvasNode,
  target: CanvasNode,
  sourceDef?: CanvasNodePluginDefinition,
  targetDef?: CanvasNodePluginDefinition,
) {
  const outputs = canvasPorts(source, sourceDef).outputs,
    inputs = canvasPorts(target, targetDef).inputs;
  const out = edge.fromPort ? outputs.find((p) => p.id === edge.fromPort) : undefined;
  const input = edge.toPort ? inputs.find((p) => p.id === edge.toPort) : undefined;
  if (edge.fromPort && !out) throw new Error('输出端口不存在：' + edge.fromPort);
  if (edge.toPort && !input) throw new Error('输入端口不存在：' + edge.toPort);
  if (
    out &&
    input &&
    !out.types.some(
      (type) =>
        input.types.includes(type) ||
        (type.startsWith('comfyui:') &&
          input.types.some(
            (t) =>
              t.startsWith('comfyui:') && (t === 'comfyui:UNKNOWN' || type === 'comfyui:UNKNOWN'),
          )) ||
        (!type.startsWith('comfyui:') &&
          !input.types.some((t) => t.startsWith('comfyui:')) &&
          (type === 'resource' || input.types.includes('resource'))),
    )
  )
    throw new Error(`${out.label} 与 ${input.label} 的类型不兼容`);
}
export function validateCanvasPortMultiplicity(
  canvas: Pick<Canvas, 'edges'>,
  edge: CanvasEdge,
  target: CanvasNode,
  definition?: CanvasNodePluginDefinition,
) {
  const input = canvasPorts(target, definition).inputs.find((p) => p.id === edge.toPort);
  if (
    input?.multiple === false &&
    canvas.edges.filter((e) => e.to === edge.to && e.toPort === edge.toPort).length > 1
  )
    throw new Error(input.label + ' 只接受一个上游输入，请先合并内容');
}
export function routeCanvasOutput(output: CanvasOutput, edge: CanvasEdge): CanvasOutput {
  const selected =
    !edge.fromPort || edge.fromPort === 'result' ? output : output.ports?.[edge.fromPort];
  if (!selected) throw new Error('运行结果中缺少输出端口：' + edge.fromPort);
  return {
    text: selected.text,
    ...('value' in selected ? { value: selected.value } : {}),
    resources: edge.toPort === 'prompt' ? [] : selected.resources,
    ...('prompt' in selected && selected.prompt ? { prompt: selected.prompt } : {}),
    ...(edge.toPort ? { inputPort: edge.toPort } : {}),
  };
}
export function connectCanvasPorts(
  canvas: Canvas,
  edge: CanvasEdge,
  definitions: CanvasNodePluginDefinition[],
): Canvas {
  if (canvas.edges.length >= 800) throw new Error('画布最多支持 800 条连线');
  const source = canvas.nodes.find((n) => n.id === edge.from),
    target = canvas.nodes.find((n) => n.id === edge.to);
  if (!source || !target || source === target) throw new Error('请选择不同的起点和目标节点');
  validateCanvasPorts(
    edge,
    source,
    target,
    definitions.find((d) => d.id === (source.pluginId ?? source.kind)),
    definitions.find((d) => d.id === (target.pluginId ?? target.kind)),
  );
  if (
    canvas.edges.some(
      (e) =>
        e.from === edge.from &&
        e.to === edge.to &&
        e.fromPort === edge.fromPort &&
        e.toPort === edge.toPort &&
        e.kind === edge.kind,
    )
  )
    throw new Error('这条连线已经存在');
  if (edge.kind === 'dependency') {
    const queue = [edge.to],
      seen = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      if (id === edge.from) throw new Error('这条连线会形成执行循环');
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(
        ...canvas.edges.filter((e) => e.kind === 'dependency' && e.from === id).map((e) => e.to),
      );
    }
  }
  const next = { ...canvas, edges: [...canvas.edges, edge] };
  validateCanvasPortMultiplicity(
    next,
    edge,
    target,
    definitions.find((d) => d.id === (target.pluginId ?? target.kind)) ?? target.definition,
  );
  return next;
}
