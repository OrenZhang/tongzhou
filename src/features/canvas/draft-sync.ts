/** Chat submission waits for the visible canvas editor, including its current selection. */
import type { TongzhouAPI } from '../../shared/types';
import type { Canvas } from '../../shared/canvas';
const editors = new Map<string, Set<() => Promise<void>>>();
export function registerCanvasDraft(sessionId: string, flush: () => Promise<void>) {
  const set = editors.get(sessionId) ?? new Set();
  set.add(flush);
  editors.set(sessionId, set);
  return () => {
    set.delete(flush);
    if (!set.size) editors.delete(sessionId);
  };
}
export async function flushCanvasDraft(sessionId: string, api?: TongzhouAPI) {
  const active = editors.get(sessionId);
  for (const flush of active ?? []) await flush();
  // Leaving the canvas page preserves a draft; submitting from chat must flush that too.
  if (active?.size || !api) return;
  const id = (await api.snapshot()).sessions.find((s) => s.id === sessionId)?.activeCanvasId;
  if (!id) return;
  const key = 'tongzhou.canvas.draft.' + id;
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return;
  }
  if (!raw) return;
  const draft = JSON.parse(raw) as Canvas;
  if (draft.id !== id) throw new Error('画布草稿不匹配，请打开画布检查');
  const { updatedAt: _, ...input } = draft;
  await api.canvasSave(input);
  try {
    if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
  } catch {}
}
