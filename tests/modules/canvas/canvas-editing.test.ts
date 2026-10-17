import { describe, it, expect, vi } from 'vitest';
import { duplicateSelection, alignSelection } from '../../../src/shared/canvas-editing';
import { fillPrompt, promptVariables } from '../../../src/shared/canvas-prompts';
import { registerCanvasDraft, flushCanvasDraft } from '../../../src/features/canvas/draft-sync';
import type { Canvas } from '../../../src/shared/canvas';

describe('canvas interaction contracts', () => {
  it('flushes a persisted draft after leaving the editor and preserves a conflicting draft', async () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => entries.get(k) ?? null,
      removeItem: (k: string) => entries.delete(k),
    });
    try {
      const raw = JSON.stringify({
        id: 'c',
        version: 2,
        updatedAt: 0,
        title: '草稿',
        nodes: [],
        edges: [],
        selection: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      entries.set('tongzhou.canvas.draft.c', raw);
      const api = {
        snapshot: async () => ({ sessions: [{ id: 's', activeCanvasId: 'c' }] }),
        canvasSave: vi.fn(async () => {}),
      };
      await flushCanvasDraft('s', api as any);
      expect(api.canvasSave).toHaveBeenCalledWith(
        expect.objectContaining({ title: '草稿', version: 2 }),
      );
      expect(entries.size).toBe(0);
      entries.set('tongzhou.canvas.draft.c', raw);
      api.canvasSave.mockRejectedValueOnce(new Error('版本冲突'));
      await expect(flushCanvasDraft('s', api as any)).rejects.toThrow('版本冲突');
      expect(entries.get('tongzhou.canvas.draft.c')).toBe(raw);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('copies only internal edges, preserves external references, and gives copies their own group', () => {
    const canvas: Canvas = {
      id: 'canvas',
      version: 1,
      updatedAt: 0,
      title: 'Canvas',
      viewport: { x: 0, y: 0, zoom: 1 },
      selection: ['a', 'b'],
      nodes: [
        { id: 'a', kind: 'text', text: 'A', title: 'A', x: 0, y: 10, group: 'group' },
        { id: 'b', kind: 'text', title: 'B', x: 300, y: 30, group: 'group' },
        { id: 'c', kind: 'text', title: 'C', x: 600, y: 0 },
      ],
      edges: [
        { id: 'e', from: 'a', to: 'b', kind: 'dependency' },
        { id: 'outer', from: 'b', to: 'c', kind: 'reference' },
      ],
    };
    let seq = 0;
    const next = duplicateSelection(canvas, () => `id-${++seq}`);
    expect(next.nodes).toHaveLength(5);
    expect(next.edges).toHaveLength(3);
    expect(next.edges[2].from).toBe(next.selection[0]);
    expect(next.edges[2].to).toBe(next.selection[1]);
    expect(next.nodes[3].group).toBe(next.nodes[4].group);
    expect(next.nodes[3].group).not.toBe('group');
    expect(alignSelection(canvas, 'top').nodes.map((n) => n.y)).toEqual([10, 10, 0]);
    expect(canvas.nodes[1].y).toBe(30);
  });
  it('fills repeated variables literally and rejects missing values', () => {
    expect(promptVariables('{{ 风格 }} / {{风格}} / {{主题}}')).toEqual(['风格', '主题']);
    expect(fillPrompt('{{主体}} / {{主体}}', { 主体: '$& {{quoted}}' })).toBe(
      '$& {{quoted}} / $& {{quoted}}',
    );
    expect(() => fillPrompt('{{风格}}', {})).toThrow('风格');
  });
  it('waits for the correct session draft and propagates conflicts before sending', async () => {
    const events: string[] = [];
    let resolve!: () => void;
    const off = registerCanvasDraft(
      'a',
      () =>
        new Promise<void>((r) => {
          resolve = () => {
            events.push('saved');
            r();
          };
        }),
    );
    await flushCanvasDraft('b');
    const send = flushCanvasDraft('a').then(() => events.push('sent'));
    expect(events).toEqual([]);
    resolve();
    await send;
    expect(events).toEqual(['saved', 'sent']);
    off();
    const fail = registerCanvasDraft('a', async () => {
      throw new Error('版本冲突');
    });
    await expect(flushCanvasDraft('a')).rejects.toThrow('版本冲突');
    fail();
    await flushCanvasDraft('a');
  });
});
