import { expect, it } from 'vitest';
import {
  applyWhiteboardOperations as apply,
  whiteboardConnections,
} from '../../../electron/modules/canvas/whiteboard';
import { emptyWhiteboard } from '../../../src/shared/whiteboard';

const node = (id: string, x: number, y: number, type = 'rectangle') => ({
  type: 'add',
  element: { id, type, x, y, width: 160, height: 100, text: id },
});
const edge = (id: string, from: string, to: string, text = '') => ({
  type: 'connect',
  id,
  from,
  to,
  text,
});
const get = (scene: ReturnType<typeof emptyWhiteboard>, id: string) =>
  scene.elements.find((e) => e.id === id)!;

it('repairs a free arrow in place and rebinds without stale reciprocal links or duplicate labels', () => {
  let scene = apply(emptyWhiteboard(), [
    node('a', 0, 0),
    node('b', 400, 0),
    node('c', 400, 300),
    {
      type: 'add',
      element: {
        id: 'line',
        type: 'arrow',
        x: 160,
        y: 50,
        points: [
          [0, 0],
          [100, -120],
          [240, 0],
        ],
        text: '已有标签',
        strokeColor: '#f00',
      },
    },
  ]).scene;
  const labelId = scene.elements.find((e) => e.containerId === 'line')!.id;
  expect(whiteboardConnections(scene)[0].bound).toBe(false);
  scene = apply(scene, [{ type: 'connect', id: 'line', from: 'a', to: 'b' }]).scene;
  expect(whiteboardConnections(scene)[0]).toMatchObject({
    bound: true,
    from: 'a',
    to: 'b',
    text: '已有标签',
  });
  expect(get(scene, 'line').strokeColor).toBe('#f00');
  expect(get(scene, labelId).isDeleted).toBe(false);
  expect(get(scene, 'line').points[1][0] + get(scene, 'line').x).toBe(260);
  scene = apply(scene, [edge('line', 'a', 'c', '重试'), edge('line', 'a', 'c', '重试')]).scene;
  expect(get(scene, 'b').boundElements.some((e: any) => e.id === 'line')).toBe(false);
  expect(get(scene, 'a').boundElements.filter((e: any) => e.id === 'line')).toHaveLength(1);
  expect(get(scene, 'c').boundElements.filter((e: any) => e.id === 'line')).toHaveLength(1);
  expect(scene.elements.filter((e) => e.containerId === 'line' && !e.isDeleted)).toHaveLength(1);
  expect(get(scene, labelId).text).toBe('重试');
});

it('accepts native binding fields in add/update, follows one bound end and supports explicit unbinding', () => {
  let scene = apply(emptyWhiteboard(), [
    node('a', 0, 0),
    node('b', 400, 0),
    {
      type: 'add',
      element: { id: 'line', type: 'arrow', x: 0, y: 0, startBinding: { elementId: 'a' } },
    },
  ]).scene;
  const endpoint = get(scene, 'line')
    .points.at(-1)
    .map((v: number, i: number) => v + (i ? get(scene, 'line').y : get(scene, 'line').x));
  scene = apply(scene, [{ type: 'update', id: 'a', patch: { y: 160 } }]).scene;
  const arrow = get(scene, 'line');
  expect(arrow.points.at(-1).map((v: number, i: number) => v + (i ? arrow.y : arrow.x))).toEqual(
    endpoint,
  );
  scene = apply(scene, [
    { type: 'update', id: 'line', patch: { endBinding: { elementId: 'b' } } },
  ]).scene;
  expect(whiteboardConnections(scene)[0].bound).toBe(true);
  scene = apply(scene, [{ type: 'update', id: 'line', patch: { startBinding: null } }]).scene;
  expect(whiteboardConnections(scene)[0]).toMatchObject({ from: null, to: 'b', bound: false });
  expect(get(scene, 'a').boundElements.some((e: any) => e.id === 'line')).toBe(false);
  expect(() =>
    apply(scene, [{ type: 'update', id: 'a', patch: { startBinding: { elementId: 'b' } } }]),
  ).toThrow('只有箭头');
});

it.each(['rectangle', 'ellipse', 'diamond'])(
  'clips diagonal %s endpoints to shape geometry after resize and rotation',
  (type) => {
    let scene = apply(emptyWhiteboard(), [
      node('a', 0, 0, type),
      node('b', 500, 400),
      edge('ab', 'a', 'b'),
    ]).scene;
    scene = apply(scene, [
      { type: 'update', id: 'a', patch: { width: 240, height: 160, angle: Math.PI / 6 } },
    ]).scene;
    const a = get(scene, 'a'),
      arrow = get(scene, 'ab');
    expect(whiteboardConnections(scene)[0].bound).toBe(true);
    const dx = arrow.x - (a.x + a.width / 2),
      dy = arrow.y - (a.y + a.height / 2);
    const l = Math.hypot(dx, dy);
    const x = ((dx * Math.cos(a.angle) + dy * Math.sin(a.angle)) * (l - 8)) / l / (a.width / 2);
    const y = ((-dx * Math.sin(a.angle) + dy * Math.cos(a.angle)) * (l - 8)) / l / (a.height / 2);
    expect(
      type === 'ellipse'
        ? Math.hypot(x, y)
        : type === 'diamond'
          ? Math.abs(x) + Math.abs(y)
          : Math.max(Math.abs(x), Math.abs(y)),
    ).toBeCloseTo(1);
  },
);

it('keeps an eight-edge login flow with decisions, merging and a retry loop bound through moves and deletion', () => {
  const nodes = ['start', 'input', 'check', 'success', 'attempts', 'locked', 'prompt', 'end'];
  const routes = [
    ['start', 'input'],
    ['input', 'check'],
    ['check', 'success'],
    ['check', 'attempts'],
    ['attempts', 'locked'],
    ['attempts', 'prompt'],
    ['prompt', 'input'],
    ['locked', 'end'],
  ];
  let scene = apply(emptyWhiteboard(), [
    ...nodes.map((id, i) =>
      node(
        id,
        (i % 3) * 320,
        Math.floor(i / 3) * 240,
        ['check', 'attempts'].includes(id) ? 'diamond' : 'rectangle',
      ),
    ),
    ...routes.map(([from, to], i) => edge('arrow_' + i, from, to, ['是', '否'][i % 2])),
  ]).scene;
  for (const id of nodes)
    scene = apply(scene, [
      { type: 'update', id, patch: { x: get(scene, id).x + 60, y: get(scene, id).y + 90 } },
    ]).scene;
  expect(whiteboardConnections(scene)).toHaveLength(8);
  expect(whiteboardConnections(scene).every((e) => e.bound)).toBe(true);
  scene = apply(scene, [{ type: 'remove', ids: ['attempts', 'arrow_0'] }]).scene;
  expect(whiteboardConnections(scene).filter((e) => !e.bound)).toHaveLength(3);
  expect(
    scene.elements
      .filter((e) => !e.isDeleted)
      .every(
        (e) => e.startBinding?.elementId !== 'attempts' && e.endBinding?.elementId !== 'attempts',
      ),
  ).toBe(true);
  expect(get(scene, 'start').boundElements.some((e: any) => e.id === 'arrow_0')).toBe(false);
});
