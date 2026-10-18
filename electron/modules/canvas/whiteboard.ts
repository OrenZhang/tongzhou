import { randomUUID, randomInt } from 'node:crypto';
import { z } from 'zod';
import type { WhiteboardElement, WhiteboardScene } from '../../../src/shared/whiteboard';

const id = z.string().min(1).max(120);
const coordinate = z.number().finite().min(-1000000).max(1000000);
export const whiteboardSceneSchema = z
  .object({
    elements: z
      .array(
        z
          .object({
            id,
            type: z.enum([
              'rectangle',
              'ellipse',
              'diamond',
              'text',
              'arrow',
              'line',
              'freedraw',
              'image',
              'frame',
              'magicframe',
              'embeddable',
              'iframe',
            ]),
            x: coordinate,
            y: coordinate,
            width: z.number().finite().min(0).max(1000000),
            height: z.number().finite().min(0).max(1000000),
            version: z.number().int().positive(),
          })
          .catchall(z.json()),
      )
      .max(5000),
    files: z.record(
      id,
      z
        .object({
          id,
          dataURL: z
            .string()
            .regex(/^data:image\/(png|jpeg|webp|gif|svg\+xml|avif);base64,/)
            .max(48 * 1024 * 1024),
          mimeType: z.string().max(80),
          created: z.number().finite(),
        })
        .catchall(z.json()),
    ),
    appState: z.record(z.string(), z.json()),
    libraryItems: z.array(z.json()).max(500).optional(),
  })
  .strict()
  .refine(
    (s) => new Set(s.elements.map((e) => e.id)).size === s.elements.length,
    '白板元素 ID 重复',
  )
  .refine((s) => JSON.stringify(s).length <= 96 * 1024 * 1024, '白板内容超过 96 MB');

const binding = z
  .object({
    elementId: id.describe('目标图形 ID；绑定后拖动图形时箭头跟随'),
    focus: z.number().min(-1).max(1).default(0),
    gap: z.number().min(0).max(100).default(8),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
  })
  .strict()
  .nullable();
const shape = z
  .object({
    id,
    type: z.enum([
      'rectangle',
      'ellipse',
      'diamond',
      'text',
      'line',
      'arrow',
      'freedraw',
      'image',
      'frame',
    ]),
    x: coordinate,
    y: coordinate,
    width: z.number().min(1).max(100000).optional(),
    height: z.number().min(1).max(100000).optional(),
    text: z.string().max(32000).optional(),
    strokeColor: z.string().max(50).optional(),
    backgroundColor: z.string().max(50).optional(),
    fontSize: z.number().min(8).max(500).optional(),
    strokeWidth: z.number().min(0).max(20).optional(),
    roughness: z.number().min(0).max(3).optional(),
    opacity: z.number().min(0).max(100).optional(),
    points: z
      .array(z.tuple([coordinate, coordinate]))
      .min(2)
      .max(5000)
      .optional(),
    fileId: id.optional(),
    startBinding: binding.optional(),
    endBinding: binding.optional(),
  })
  .strict();
const patch = shape
  .omit({ id: true, type: true })
  .partial()
  .extend({
    angle: z.number().finite().optional(),
    locked: z.boolean().optional(),
    groupIds: z.array(id).max(20).optional(),
    fillStyle: z.enum(['solid', 'hachure', 'cross-hatch', 'zigzag']).optional(),
    frameId: id.nullable().optional(),
    link: z.string().max(2000).nullable().optional(),
    startArrowhead: z
      .enum([
        'arrow',
        'bar',
        'dot',
        'triangle',
        'diamond',
        'circle',
        'circle_outline',
        'triangle_outline',
        'diamond_outline',
        'crowfoot_one',
        'crowfoot_many',
        'crowfoot_one_or_many',
      ])
      .nullable()
      .optional(),
    endArrowhead: z
      .enum([
        'arrow',
        'bar',
        'dot',
        'triangle',
        'diamond',
        'circle',
        'circle_outline',
        'triangle_outline',
        'diamond_outline',
        'crowfoot_one',
        'crowfoot_many',
        'crowfoot_one_or_many',
      ])
      .nullable()
      .optional(),
    strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
    textAlign: z.enum(['left', 'center', 'right']).optional(),
    fontFamily: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export const whiteboardOperationsSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('add'), element: shape }).strict(),
      z.object({ type: z.literal('update'), id, patch }).strict(),
      z.object({ type: z.literal('remove'), ids: z.array(id).min(1).max(500) }).strict(),
      z
        .object({
          type: z
            .literal('connect')
            .describe('创建绑定箭头，或使用已有箭头 ID 原位修复/更换绑定；无需先删除'),
          id,
          from: id,
          to: id,
          text: z.string().max(2000).optional(),
          strokeColor: z.string().max(50).optional(),
        })
        .strict(),
      z.object({ type: z.literal('select'), ids: z.array(id).max(500) }).strict(),
      z.object({ type: z.literal('rename'), title: z.string().trim().min(1).max(180) }).strict(),
    ]),
  )
  .min(1)
  .max(200);

function base(spec: z.infer<typeof shape>): WhiteboardElement {
  return {
    ...spec,
    width: spec.width ?? 200,
    height: spec.height ?? 100,
    angle: 0,
    strokeColor: spec.strokeColor ?? '#1e1e1e',
    backgroundColor: spec.backgroundColor ?? 'transparent',
    fillStyle: 'solid',
    strokeWidth: spec.strokeWidth ?? 2,
    strokeStyle: 'solid',
    roughness: spec.roughness ?? 1,
    opacity: spec.opacity ?? 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: spec.type === 'rectangle' ? { type: 3 } : null,
    seed: randomInt(1, 2147483647),
    version: 1,
    versionNonce: randomInt(1, 2147483647),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}
function textElement(
  id: string,
  text: string,
  x: number,
  y: number,
  fontSize = 20,
  width?: number,
): WhiteboardElement {
  const lines = text.split('\n');
  return {
    ...base({ id, type: 'text', x, y }),
    text,
    originalText: text,
    fontSize,
    fontFamily: 5,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    lineHeight: 1.25,
    autoResize: width === undefined,
    width:
      width ??
      Math.max(
        fontSize,
        ...lines.map((l) =>
          [...l].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? fontSize : fontSize * 0.6), 0),
        ),
      ),
    height: Math.max(1, lines.length) * fontSize * 1.25,
  };
}
function touch(element: WhiteboardElement) {
  element.version++;
  element.versionNonce = randomInt(1, 2147483647);
  element.updated = Date.now();
}
export function whiteboardConnections(scene: WhiteboardScene) {
  const live = scene.elements.filter((e) => !e.isDeleted);
  return live
    .filter((e) => e.type === 'arrow')
    .map((e) => ({
      id: e.id,
      from: e.startBinding?.elementId ?? null,
      to: e.endBinding?.elementId ?? null,
      bound: [e.startBinding, e.endBinding].every(
        (b) =>
          b &&
          live.some(
            (target) =>
              target.id === b.elementId &&
              target.boundElements?.some((item: any) => item.id === e.id && item.type === 'arrow'),
          ),
      ),
      text: live.find((t) => t.containerId === e.id && t.type === 'text')?.text ?? '',
    }));
}
/** Only supplied operations are changed; the caller checks the document revision before committing. */
export function applyWhiteboardOperations(input: WhiteboardScene, raw: unknown) {
  const scene = structuredClone(input),
    ops = whiteboardOperationsSchema.parse(raw);
  const geometryChanged = new Set<string>();
  let title: string | undefined;
  const find = (id: string) => {
    const e = scene.elements.find((e) => e.id === id && !e.isDeleted);
    if (!e) throw Error(`白板元素不存在：${id}`);
    return e;
  };
  const add = (e: WhiteboardElement) => {
    if (scene.elements.some((v) => v.id === e.id)) throw Error(`白板元素 ID 已存在：${e.id}`);
    scene.elements.push(e);
  };
  const bind = (
    e: WhiteboardElement,
    side: 'startBinding' | 'endBinding',
    value: z.infer<typeof binding>,
  ) => {
    if (e.type !== 'arrow') throw Error('只有箭头支持端点绑定');
    if (value) {
      const target = find(value.elementId);
      if (
        target.id === e.id ||
        !['rectangle', 'ellipse', 'diamond', 'text', 'image'].includes(target.type) ||
        target.containerId
      )
        throw Error('请选择可连接的独立图形');
    }
    e[side] = value ? { ...value, fixedPoint: value.fixedPoint ?? null } : null;
    // Rebuild just this arrow's reciprocal references, including when both ends share a target.
    for (const target of scene.elements) {
      const bound = [e.startBinding?.elementId, e.endBinding?.elementId].includes(target.id);
      const previous = target.boundElements ?? [];
      const next = previous.filter((item: any) => item.id !== e.id);
      if (bound) next.push({ id: e.id, type: 'arrow' });
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        target.boundElements = next;
        touch(target);
      }
    }
    geometryChanged.add(e.id);
  };
  const label = (e: WhiteboardElement, text: string) => {
    const existing = scene.elements.find(
      (t) => t.type === 'text' && t.containerId === e.id && !t.isDeleted,
    );
    const t =
      existing ??
      textElement(randomUUID(), text, e.x + 10, e.y + 10, 20, Math.max(20, e.width - 20));
    t.text = text;
    t.originalText = text;
    t.containerId = e.id;
    t.textAlign = 'center';
    t.verticalAlign = 'middle';
    t.autoResize = false;
    t.width =
      e.type === 'arrow'
        ? textElement(t.id, text, 0, 0, t.fontSize ?? 20).width
        : Math.max(20, e.width - 20);
    t.height = Math.max(1, text.split('\n').length) * (t.fontSize ?? 20) * 1.25;
    t.x = e.x + 10;
    t.y = e.y + (e.height - t.height) / 2;
    if (existing) touch(t);
    else {
      add(t);
      e.boundElements = [...(e.boundElements ?? []), { id: t.id, type: 'text' }];
    }
  };
  for (const op of ops) {
    if (op.type === 'rename') {
      title = op.title;
      continue;
    }
    if (op.type === 'select') {
      op.ids.forEach(find);
      scene.appState.selectedElementIds = Object.fromEntries(op.ids.map((id) => [id, true]));
      continue;
    }
    if (op.type === 'remove') {
      const removed = new Set(op.ids);
      op.ids.forEach(find);
      for (const e of scene.elements)
        if (removed.has(e.id) || removed.has(e.containerId)) {
          e.isDeleted = true;
          touch(e);
          removed.add(e.id);
        }
      for (const e of scene.elements) {
        const before = JSON.stringify(e);
        if (e.boundElements)
          e.boundElements = e.boundElements.filter((b: any) => !removed.has(b.id));
        if (removed.has(e.startBinding?.elementId)) e.startBinding = null;
        if (removed.has(e.endBinding?.elementId)) e.endBinding = null;
        if (removed.has(e.frameId)) e.frameId = null;
        if (JSON.stringify(e) !== before) touch(e);
      }
      scene.appState.selectedElementIds = Object.fromEntries(
        Object.entries(scene.appState.selectedElementIds ?? {}).filter(([id]) => !removed.has(id)),
      );
      continue;
    }
    if (op.type === 'connect') {
      const from = find(op.from),
        to = find(op.to);
      if (from.id === to.id) throw Error('箭头的起点和终点不能相同');
      if (
        [from, to].some(
          (e) => !['rectangle', 'ellipse', 'diamond', 'text', 'image'].includes(e.type),
        )
      )
        throw Error('请选择可连接的图形');
      const existing = scene.elements.find((e) => e.id === op.id && !e.isDeleted);
      if (existing && existing.type !== 'arrow') throw Error('连线 ID 已用于非箭头元素');
      const e =
        existing ??
        base({
          id: op.id,
          type: 'arrow',
          x: from.x + from.width,
          y: from.y + from.height / 2,
          strokeColor: op.strokeColor,
        });
      e.points ??= [
        [0, 0],
        [to.x - e.x, to.y + to.height / 2 - e.y],
      ];
      if (!existing) {
        e.startArrowhead = null;
        e.endArrowhead = 'arrow';
        e.elbowed = false;
        add(e);
      }
      if (op.strokeColor !== undefined) e.strokeColor = op.strokeColor;
      bind(e, 'startBinding', { elementId: from.id, focus: 0, gap: 8 });
      bind(e, 'endBinding', { elementId: to.id, focus: 0, gap: 8 });
      touch(e);
      geometryChanged.add(e.id);
      if (op.text !== undefined) label(e, op.text);
    } else if (op.type === 'add') {
      const s = op.element;
      const e =
        s.type === 'text'
          ? { ...textElement(s.id, s.text ?? '', s.x, s.y, s.fontSize, s.width), ...s }
          : base(s);
      if (['arrow', 'line', 'freedraw'].includes(s.type)) {
        e.points = s.points ?? [
          [0, 0],
          [s.width ?? 200, s.height ?? 0],
        ];
        e.width =
          Math.max(...e.points.map((p: number[]) => p[0])) -
          Math.min(...e.points.map((p: number[]) => p[0]));
        e.height =
          Math.max(...e.points.map((p: number[]) => p[1])) -
          Math.min(...e.points.map((p: number[]) => p[1]));
        if (s.type === 'freedraw') {
          e.pressures = [];
          e.simulatePressure = true;
        } else {
          e.startBinding = null;
          e.endBinding = null;
          e.startArrowhead = null;
          e.endArrowhead = s.type === 'arrow' ? 'arrow' : null;
          e.elbowed = false;
        }
      }
      if (s.type === 'image') {
        if (!s.fileId || !scene.files[s.fileId]) throw Error('图片文件不存在，请先由用户导入图片');
        e.status = 'saved';
        e.scale = [1, 1];
        e.crop = null;
      }
      if (s.type === 'frame') e.name = s.text ?? null;
      add(e);
      if (s.startBinding !== undefined) bind(e, 'startBinding', s.startBinding);
      if (s.endBinding !== undefined) bind(e, 'endBinding', s.endBinding);
      if (s.text && ['rectangle', 'ellipse', 'diamond', 'arrow'].includes(s.type)) {
        delete e.text;
        label(e, s.text);
      }
    } else if (op.type === 'update') {
      const e = find(op.id),
        oldX = e.x,
        oldY = e.y;
      if (op.patch.fileId && !scene.files[op.patch.fileId]) throw Error('图片文件不存在');
      if (op.patch.frameId && find(op.patch.frameId).type !== 'frame') throw Error('目标不是画框');
      const { text, startBinding, endBinding, ...fields } = op.patch;
      Object.assign(e, fields);
      if (startBinding !== undefined) bind(e, 'startBinding', startBinding);
      if (endBinding !== undefined) bind(e, 'endBinding', endBinding);
      touch(e);
      for (const child of scene.elements)
        if (child.containerId === e.id && !child.isDeleted) {
          child.x += e.x - oldX;
          child.y += e.y - oldY;
          touch(child);
        }
      if (
        ['width', 'height'].some((k) => k in op.patch) &&
        ['rectangle', 'ellipse', 'diamond'].includes(e.type)
      ) {
        const existingText = scene.elements.find(
          (t) => t.containerId === e.id && t.type === 'text' && !t.isDeleted,
        );
        if (existingText) label(e, existingText.text ?? '');
      }
      if (text !== undefined) {
        if (e.type === 'text') {
          const dimensions = textElement(
            e.id,
            text,
            e.x,
            e.y,
            e.fontSize,
            e.autoResize ? undefined : e.width,
          );
          e.text = text;
          e.originalText = text;
          e.width = dimensions.width;
          e.height = dimensions.height;
        } else if (e.type === 'frame') e.name = text;
        else if (['rectangle', 'ellipse', 'diamond', 'arrow'].includes(e.type)) label(e, text);
        else throw Error('该图形不支持绑定文字');
      }
      if (['x', 'y', 'width', 'height', 'angle', 'points'].some((k) => k in op.patch))
        geometryChanged.add(e.id);
    }
  }
  // Clip against the real shape (including rotation), not its rectangular bounding box.
  const endpoint = (target: WhiteboardElement, toward: number[], gap: number, focus = 0) => {
    const cx = target.x + target.width / 2,
      cy = target.y + target.height / 2;
    const angle = target.angle ?? 0,
      cos = Math.cos(angle),
      sin = Math.sin(angle);
    const dx = (toward[0] - cx) * cos + (toward[1] - cy) * sin;
    const dy = -(toward[0] - cx) * sin + (toward[1] - cy) * cos;
    const rx = Math.max(1, target.width / 2),
      ry = Math.max(1, target.height / 2);
    const length = Math.hypot(dx, dy) || 1;
    // A focus offset allows non-central native bindings to stay on their chosen side.
    const vx = dx - (dy / length) * focus * rx,
      vy = dy + (dx / length) * focus * ry;
    const divisor =
      target.type === 'ellipse'
        ? Math.hypot(vx / rx, vy / ry)
        : target.type === 'diamond'
          ? Math.abs(vx) / rx + Math.abs(vy) / ry
          : Math.max(Math.abs(vx) / rx, Math.abs(vy) / ry);
    const scale = divisor ? 1 / divisor : 0;
    const norm = Math.hypot(vx, vy) || 1;
    const x = vx * scale + (vx / norm) * gap,
      y = vy * scale + (vy / norm) * gap;
    return [cx + x * cos - y * sin, cy + x * sin + y * cos];
  };
  for (const e of scene.elements) {
    if (
      e.isDeleted ||
      e.type !== 'arrow' ||
      ![e.id, e.startBinding?.elementId, e.endBinding?.elementId].some((id) =>
        geometryChanged.has(id),
      )
    )
      continue;
    const old = (
      e.points ?? [
        [0, 0],
        [e.width, e.height],
      ]
    ).map((p: number[]) => [e.x + p[0], e.y + p[1]]);
    const a = e.startBinding ? find(e.startBinding.elementId) : undefined;
    const b = e.endBinding ? find(e.endBinding.elementId) : undefined;
    const center = (shape: WhiteboardElement) => [
      shape.x + shape.width / 2,
      shape.y + shape.height / 2,
    ];
    const start = a
      ? endpoint(
          a,
          old.length > 2 ? old[1] : b ? center(b) : old.at(-1),
          e.startBinding.gap,
          e.startBinding.focus,
        )
      : old[0];
    const end = b
      ? endpoint(
          b,
          old.length > 2 ? old.at(-2) : a ? center(a) : old[0],
          e.endBinding.gap,
          e.endBinding.focus,
        )
      : old.at(-1);
    const points = [start, ...old.slice(1, -1), end].map((p: number[]) => [
      p[0] - start[0],
      p[1] - start[1],
    ]);
    e.x = start[0];
    e.y = start[1];
    e.points = points;
    e.width =
      Math.max(...points.map((p: number[]) => p[0])) -
      Math.min(...points.map((p: number[]) => p[0]));
    e.height =
      Math.max(...points.map((p: number[]) => p[1])) -
      Math.min(...points.map((p: number[]) => p[1]));
    touch(e);
    // Place a connector label halfway along its polyline, including routed return branches.
    const absolute = [start, ...old.slice(1, -1), end];
    const lengths = absolute
      .slice(1)
      .map((p: number[], i: number) => Math.hypot(p[0] - absolute[i][0], p[1] - absolute[i][1]));
    let remaining = lengths.reduce((a: number, b: number) => a + b, 0) / 2;
    let midpoint = start;
    for (let i = 0; i < lengths.length; i++) {
      if (remaining <= lengths[i]) {
        const fraction = lengths[i] ? remaining / lengths[i] : 0;
        midpoint = absolute[i].map(
          (v: number, j: number) => v + (absolute[i + 1][j] - v) * fraction,
        );
        break;
      }
      remaining -= lengths[i];
    }
    for (const t of scene.elements)
      if (t.containerId === e.id && !t.isDeleted) {
        t.x = midpoint[0] - t.width / 2;
        t.y = midpoint[1] - t.height / 2;
        touch(t);
      }
  }
  return { scene: whiteboardSceneSchema.parse(scene) as WhiteboardScene, title };
}
