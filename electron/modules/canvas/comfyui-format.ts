import { createHash, randomUUID } from 'node:crypto';
import type {
  Canvas,
  CanvasNode,
  CanvasNodePluginDefinition,
  CanvasPort,
  CanvasValueType,
} from '../../../src/shared/canvas';

export type ComfyCatalog = Record<string, any>;
export type ComfyConfig = {
  sourceId: string;
  nodeId: string;
  classType: string;
  connectionId?: string;
  values: Record<string, unknown>;
  controls?: Record<string, string>;
  issues?: string[];
};
export const comfyConfig = (node?: CanvasNode) =>
  node?.definition?.adapter === 'comfyui' ? (node.config as unknown as ComfyConfig) : undefined;
export const comfyHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const comfyInput = (name: string) => {
  if (!name || name.length > 100) throw new Error('ComfyUI 参数名为空或过长');
  return 'in:' + name;
};
const typeOf = (type: string): CanvasValueType =>
  (({ STRING: 'text', INT: 'number', FLOAT: 'number', BOOLEAN: 'boolean' })[
    type
  ] as CanvasValueType) ?? `comfyui:${type}`;
const scalar = (value: unknown) =>
  typeof value === 'string'
    ? 'text'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'boolean'
        : 'json';
export function comfyFields(info: any) {
  // /object_info commonly returns the legacy shape; node-definition v2 uses named inputs.
  if (info?.input) return { ...(info.input.required ?? {}), ...(info.input.optional ?? {}) };
  return Object.fromEntries(
    Object.entries(info?.inputs ?? {})
      .filter(([, v]: any) => !v.hidden)
      .map(([key, v]: any) => [key, [v.type === 'COMBO' ? v.options : v.type, v]]),
  );
}
function nodeDefinition(
  classType: string,
  info: any,
  values: Record<string, unknown>,
  inferred: string[],
  outputCount: number,
): CanvasNodePluginDefinition {
  const fields = comfyFields(info);
  const properties: Record<string, any> = Object.create(null);
  const inputs: CanvasPort[] = [];
  for (const name of new Set([...Object.keys(fields), ...Object.keys(values), ...inferred])) {
    const [type, opts = {}] = fields[name] ?? [undefined, {}];
    const actual = Array.isArray(type)
      ? scalar(type[0])
      : type
        ? typeOf(type)
        : name in values
          ? scalar(values[name])
          : 'comfyui:UNKNOWN';
    const upload = opts.image_upload || (classType === 'LoadImage' && name === 'image');
    inputs.push({
      id: comfyInput(name),
      label: name,
      multiple: false,
      types: upload ? ['image'] : [actual],
    });
    if (actual.startsWith('comfyui:') && !(name in values)) continue;
    properties[name] = {
      type:
        actual === 'text' ? 'string' : ['number', 'boolean'].includes(actual) ? actual : 'object',
      ...(type === 'INT' ? { type: 'integer' } : {}),
      ...(Array.isArray(type) ? { enum: type } : {}),
      ...(opts.default !== undefined ? { default: opts.default } : {}),
      ...(opts.min !== undefined ? { minimum: opts.min } : {}),
      ...(opts.max !== undefined ? { maximum: opts.max } : {}),
      ...(opts.step !== undefined ? { 'x-step': opts.step } : {}),
    };
  }
  const types: string[] = info?.output ?? (info?.outputs ?? []).map((v: any) => v.type);
  const outputs = Array.from(
    { length: Math.max(types.length, outputCount) },
    (_, i): CanvasPort => ({
      id: 'out:' + i,
      label: info?.output_name?.[i] ?? info?.outputs?.[i]?.name ?? types[i] ?? `输出 ${i + 1}`,
      types: [typeOf(types[i] ?? 'UNKNOWN')],
    }),
  );
  // Files are materialized only at output nodes, never at an internal IMAGE tensor edge.
  if (
    info?.output_node ||
    info?.isOutputNode ||
    /^(SaveImage|PreviewImage|SaveAnimatedWEBP|SaveVideo|SaveAudio)$/.test(classType)
  )
    outputs.push({ id: 'files', label: '生成文件', types: ['resource'] });
  return {
    id: 'comfyui.' + comfyHash({ classType, fields, inputs, outputs, properties }).slice(0, 24),
    name: info?.display_name ?? classType,
    kind: 'plugin',
    version: 1,
    apiVersion: 1,
    adapter: 'comfyui',
    cache: 'never',
    description: classType,
    inputs: inputs.flatMap((p) => p.types),
    outputs: outputs.flatMap((p) => p.types),
    ports: { inputs, outputs },
    configSchema: { type: 'object', properties },
  };
}
export function parseComfyWorkflow(
  raw: any,
  sourceId: string,
  catalog: ComfyCatalog = {},
  connectionId?: string,
): { nodes: CanvasNode[]; edges: Canvas['edges']; warnings: string[]; format: 'api' | 'ui' } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('ComfyUI 工作流必须为 JSON 对象');
  const ui = Array.isArray(raw.nodes);
  if (ui && ![0.4, 1].includes(raw.version))
    throw new Error('支持 ComfyUI UI 工作流 0.4 / 1.0，其他版本请先导出 API 格式');
  const rows: any[] = ui
    ? raw.nodes
    : Object.entries(raw).map(([id, v]: any) => ({
        id,
        type: v?.class_type,
        values: v?.inputs,
        title: v?._meta?.title,
      }));
  if (!rows.length || rows.length > 200 || rows.some((n) => !n || typeof n.type !== 'string'))
    throw new Error('请选择有效的 ComfyUI 工作流（1–200 个节点）');
  const ids = new Map<string, string>();
  for (const n of rows) {
    const key = String(n.id);
    if (
      (typeof n.id !== 'string' && (typeof n.id !== 'number' || !Number.isInteger(n.id))) ||
      !key ||
      key.length > 120 ||
      !n.type ||
      n.type.length > 200
    )
      throw new Error('ComfyUI 节点 ID 或类型无效');
    if (ids.has(key)) throw new Error('ComfyUI 节点 ID 重复');
    ids.set(key, randomUUID());
  }
  const links = new Map<string, any>();
  for (const v of raw.links ?? []) {
    const link = Array.isArray(v)
      ? { id: v[0], origin_id: v[1], origin_slot: v[2], target_id: v[3], target_slot: v[4] }
      : v;
    if (!link || links.has(String(link.id))) throw new Error('ComfyUI 连线重复或无效');
    links.set(String(link.id), link);
  }
  const warnings: string[] = [];
  if (raw.definitions?.subgraphs?.length)
    warnings.push('包含子图，目前需在 ComfyUI 展开后导出 API 格式');
  const edges: Canvas['edges'] = [];
  const nodes = rows.map((row, i): CanvasNode => {
    const info = Object.hasOwn(catalog, row.type) ? catalog[row.type] : undefined;
    const values: Record<string, unknown> = Object.create(null);
    const issues: string[] = [];
    const controls: Record<string, string> = {};
    const wires: [string, string, number][] = [];
    if (!ui) {
      if (!row.values || typeof row.values !== 'object' || Array.isArray(row.values))
        throw new Error('ComfyUI API 节点缺少 inputs');
      for (const [key, value] of Object.entries(row.values)) {
        if (
          Array.isArray(value) &&
          value.length === 2 &&
          (typeof value[0] === 'string' || typeof value[0] === 'number') &&
          Number.isInteger(value[1]) &&
          ids.has(String(value[0]))
        )
          wires.push([key, String(value[0]), value[1]]);
        else values[key] = value;
      }
    } else {
      for (const input of row.inputs ?? []) {
        if (input.link == null) continue;
        const link = links.get(String(input.link));
        if (!link || String(link.target_id) !== String(row.id) || !ids.has(String(link.origin_id)))
          throw new Error('ComfyUI 连线引用无效');
        wires.push([input.name, String(link.origin_id), link.origin_slot]);
      }
      const widgets = row.widgets_values ?? [];
      if (!Array.isArray(widgets)) Object.assign(values, widgets);
      else if (widgets.length) {
        if (!info) issues.push('需要连接服务后解析控件参数');
        else {
          let cursor = 0;
          for (const [name, field] of Object.entries(comfyFields(info)) as [string, any][]) {
            const [type, opts = {}] = field;
            if (
              (Array.isArray(type) ||
                ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(type)) &&
              !opts.forceInput &&
              !opts.force_input
            ) {
              if (cursor >= widgets.length) {
                issues.push('控件参数不足，请核对或改用 API 格式');
                break;
              }
              values[name] = widgets[cursor++];
              if (
                (opts.control_after_generate || (name === 'seed' && type === 'INT')) &&
                ['fixed', 'increment', 'decrement', 'randomize'].includes(widgets[cursor])
              ) {
                controls[name] = widgets[cursor++];
              }
            }
          }
          if (cursor !== widgets.length)
            issues.push('存在未映射的自定义控件，请使用 API 格式或补充适配');
        }
      }
      if (row.mode && row.mode !== 0)
        issues.push('包含禁用或旁路节点，请在 ComfyUI 整理后导出 API 格式');
    }
    if (raw.definitions?.subgraphs?.length) issues.push('子图待适配');
    for (const [name, from, slot] of wires) {
      if (!Number.isInteger(slot) || slot < 0) throw new Error('ComfyUI 输出槽无效');
      edges.push({
        id: randomUUID(),
        from: ids.get(from)!,
        to: ids.get(String(row.id))!,
        kind: 'dependency',
        fromPort: 'out:' + slot,
        toPort: comfyInput(name),
      });
    }
    if (!info) warnings.push(`${row.type}：未发现节点定义，执行前需要检查服务`);
    warnings.push(...issues.map((issue) => `${row.type}：${issue}`));
    const outputCount = ui
      ? (row.outputs?.length ?? 0)
      : Math.max(
          0,
          ...rows.flatMap((r) =>
            Object.values(r.values ?? {})
              .filter((v: any) => Array.isArray(v) && String(v[0]) === String(row.id))
              .map((v: any) => v[1] + 1),
          ),
        );
    const definition = nodeDefinition(
      row.type,
      info,
      values,
      wires.map((w) => w[0]),
      outputCount,
    );
    const config: ComfyConfig = {
      sourceId,
      nodeId: String(row.id),
      classType: row.type,
      ...(connectionId ? { connectionId } : {}),
      values,
      ...(Object.keys(controls).length ? { controls } : {}),
      ...(issues.length ? { issues } : {}),
    };
    return {
      id: ids.get(String(row.id))!,
      kind: 'plugin',
      pluginId: definition.id,
      definition,
      title: String(row.title || info?.display_name || row.type).slice(0, 180),
      x: Math.max(-100000, Math.min(100000, Number(row.pos?.[0] ?? (i % 4) * 340))),
      y: Math.max(-100000, Math.min(100000, Number(row.pos?.[1] ?? Math.floor(i / 4) * 270))),
      width: 280,
      height: 200,
      config: config as unknown as Record<string, unknown>,
    };
  });
  if (edges.length > 800) throw new Error('ComfyUI 工作流超过 800 条连线');
  return { nodes, edges, warnings: [...new Set(warnings)], format: ui ? 'ui' : 'api' };
}

/** Collapse only complete imported graph units, then topologically sort the quotient graph. */
