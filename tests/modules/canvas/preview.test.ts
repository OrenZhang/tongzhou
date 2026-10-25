import { describe, expect, it } from 'vitest';
import { canvasNodePreviews, canvasPreviewItems } from '../../../src/shared/canvas-preview';
import type { Canvas, CanvasNode, CanvasNodeRun, CanvasResource } from '../../../src/shared/canvas';

const oldImage: CanvasResource = { kind: 'artifact', id: 'old-image' };
const newImage: CanvasResource = { kind: 'content', id: 'new-image', version: 1 };
const node: CanvasNode = { id: 'image', kind: 'image', title: '人物', x: 0, y: 0 };
const previous: CanvasNodeRun = {
  status: 'completed',
  generation: [],
  output: { text: '', resources: [oldImage] },
};
const canvas: Canvas = {
  id: 'canvas',
  title: '',
  version: 1,
  updatedAt: 0,
  nodes: [node],
  edges: [],
  selection: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

describe('canvas preview originals', () => {
  it('opens the same historical image that remains visible after a failed regeneration', () => {
    const failed: CanvasNodeRun = {
      status: 'failed',
      generation: [{ index: 0, status: 'failed', resources: [] }],
      output: { text: 'failed', resources: [] },
    };
    const shown = canvasNodePreviews(node, failed, previous);
    expect(shown.showingPrevious).toBe(true);
    expect(shown.resources).toEqual([oldImage]);
    expect(canvasPreviewItems(canvas, { image: failed }, { image: previous })).toEqual([
      { resource: oldImage, title: '人物', revision: shown.revision },
    ]);
  });

  it('prefers current partial results and explicit originals over historical results', () => {
    const partial: CanvasNodeRun = {
      status: 'failed',
      generation: [
        { index: 0, status: 'completed', resources: [newImage, newImage] },
        { index: 1, status: 'failed', resources: [] },
      ],
    };
    expect(canvasNodePreviews(node, partial, previous).resources).toEqual([newImage]);
    expect(canvasNodePreviews({ ...node, resource: oldImage }, partial).resources).toEqual([
      oldImage,
    ]);
    expect(
      canvasNodePreviews({ ...node, media: { mode: 'existing' } }, undefined, previous).resources,
    ).toEqual([]);
  });

  it('refreshes originals when the same artifact finishes downloading', () => {
    const saving: CanvasNodeRun = {
      status: 'running',
      generation: [{ index: 0, status: 'running', phase: 'save', resources: [oldImage] }],
    };
    const complete: CanvasNodeRun = {
      status: 'completed',
      generation: [{ index: 0, status: 'completed', phase: 'save', resources: [oldImage] }],
    };
    expect(canvasNodePreviews(node, saving).revision).not.toBe(
      canvasNodePreviews(node, complete).revision,
    );
  });

  it('includes content and workspace originals in a gallery and falls back from empty generations', () => {
    const file: CanvasResource = { kind: 'file', projectId: 'project', path: 'image.png' };
    const graph = { ...canvas, nodes: [{ ...node, kind: 'resource' as const, resource: file }] };
    expect(canvasPreviewItems(graph, {})[0].resource).toEqual(file);
    expect(
      canvasPreviewItems(canvas, {
        image: { ...previous, output: { text: '', resources: [newImage] } },
      })[0].resource,
    ).toEqual(newImage);
  });
});
