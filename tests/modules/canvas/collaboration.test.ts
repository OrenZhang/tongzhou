import { describe, expect, it } from 'vitest';
import type { Canvas } from '../../../src/shared/canvas';
import {
  canvasChatPrompt,
  canvasChatUserText,
  mergeCanvasChanges,
} from '../../../src/shared/canvas-collaboration';

const base = (): Canvas => ({
  id: 'c',
  title: '流程',
  version: 1,
  updatedAt: 1,
  nodes: [
    { id: 'a', kind: 'text', title: '原文', text: '初稿', x: 0, y: 0 },
    {
      id: 'b',
      kind: 'agent',
      title: '处理',
      text: '要求',
      x: 300,
      y: 0,
      config: { count: 1, style: '水彩' },
    },
  ],
  edges: [{ id: 'ab', from: 'a', to: 'b', kind: 'dependency' }],
  selection: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});
describe('canvas collaboration', () => {
  it('merges edits to different fields and keeps local viewport/selection', () => {
    const original = base(),
      local = base(),
      remote = base();
    local.nodes[1].x = 420;
    local.nodes[1].config!.count = 2;
    local.selection = ['b'];
    local.viewport.zoom = 1.5;
    remote.version = 2;
    remote.nodes[1].text = 'AI 新要求';
    remote.nodes[1].config!.style = '素描';
    const result = mergeCanvasChanges(original, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.canvas.nodes[1]).toMatchObject({
      x: 420,
      text: 'AI 新要求',
      config: { count: 2, style: '素描' },
    });
    expect(result.canvas.selection).toEqual(['b']);
    expect(result.canvas.viewport.zoom).toBe(1.5);
    expect(result.canvas.version).toBe(2);
    expect(result.dirty).toBe(true);
    expect(original).toEqual(base());
  });
  it('reports concurrent edits/deletion rather than silently overwriting', () => {
    const local = base(),
      remote = base();
    local.nodes[1].text = '我的修改';
    remote.nodes[1].text = 'AI 修改';
    expect(mergeCanvasChanges(base(), local, remote).conflicts).toContain('nodes.b.text');
    remote.nodes = remote.nodes.filter((n) => n.id !== 'b');
    remote.edges = [];
    expect(mergeCanvasChanges(base(), local, remote).conflicts).toContain('nodes.b');
  });
  it('accepts new nodes and flags edges whose nodes were deleted concurrently', () => {
    const local = base(),
      remote = base();
    local.nodes = [];
    local.edges = [];
    remote.edges.push({ id: 'ba', from: 'b', to: 'a', kind: 'reference' });
    expect(mergeCanvasChanges(base(), local, remote).conflicts).toContain('edges.ba');
    const fresh = base();
    fresh.version = 2;
    fresh.nodes.push({ id: 'c', kind: 'text', title: '新节点', x: 600, y: 0 });
    expect(mergeCanvasChanges(base(), base(), fresh)).toMatchObject({
      conflicts: [],
      dirty: false,
    });
  });
  it('keeps user text separate from the canvas collaboration instructions', () => {
    const text = '增加角色节点\n保留我刚改的描述';
    const prompt = canvasChatPrompt('c', text);
    expect(prompt).toContain('canvas_apply');
    expect(prompt).toContain('version');
    expect(canvasChatUserText(prompt)).toBe(text);
  });
});
