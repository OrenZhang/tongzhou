import type { ArtifactPreview } from './artifacts';
import type { Canvas, CanvasNode, CanvasNodeRun, CanvasResource } from './canvas';

export const resourceKey = (resource: CanvasResource) => JSON.stringify(resource);
export type CanvasPreviewItem = { resource: CanvasResource; title: string; revision?: string };
const listeners = new Set<(key: string) => void>();
export function invalidateCanvasPreview(resource: CanvasResource) {
  for (const listener of listeners) listener(resourceKey(resource));
}
export function subscribeCanvasPreview(listener: (key: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function runResources(step?: CanvasNodeRun) {
  const generated = step?.generation?.flatMap((item) => item.resources) ?? [];
  return generated.length ? generated : (step?.output?.resources ?? []);
}

/** The node and its gallery must display the same current or historical originals. */
export function canvasNodePreviews(
  node: CanvasNode,
  step?: CanvasNodeRun,
  previousStep?: CanvasNodeRun,
) {
  const current = runResources(step);
  const previous = runResources(previousStep);
  const showingPrevious =
    node.media?.mode !== 'existing' && !node.resource && !current.length && previous.length > 0;
  const resources = node.resource ? [node.resource] : showingPrevious ? previous : current;
  const displayed = showingPrevious ? previousStep : step;
  return {
    resources: [...new Map(resources.map((r) => [resourceKey(r), r])).values()],
    showingPrevious,
    revision: JSON.stringify([
      displayed?.status,
      displayed?.endedAt,
      displayed?.generation?.map((item) => [item.status, item.phase]),
    ]),
  };
}

export function canvasPreviewItems(
  canvas: Canvas,
  steps: Record<string, CanvasNodeRun>,
  previousSteps?: Record<string, CanvasNodeRun>,
): CanvasPreviewItem[] {
  return canvas.nodes.flatMap((node) => {
    const { resources, revision } = canvasNodePreviews(
      node,
      steps[node.id],
      node.kind === 'image' || node.kind === 'video' ? previousSteps?.[node.id] : undefined,
    );
    return resources
      .filter((r) => r.kind !== 'message')
      .map((resource, i) => ({
        resource,
        revision,
        title: node.title + (resources.length > 1 ? ` · ${i + 1}` : ''),
      }));
  });
}

export function canvasPreviewIssue(preview: ArtifactPreview) {
  if (preview.type === 'external') return '原件尚未下载，请下载后预览。';
  if (!['image', 'video', 'audio'].includes(preview.type))
    return '此资源不支持媒体预览，请选择图片、视频或音频。';
  if (!preview.content) return '媒体原件为空，请重新选择或下载原件。';
  return '';
}
