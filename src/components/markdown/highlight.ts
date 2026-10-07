import type { Root } from 'hast';
let worker: Worker | undefined;
let next = 0;
const jobs = new Map<
  number,
  { done: (tree?: Root) => void; timer: ReturnType<typeof setTimeout> }
>();
function reset() {
  worker?.terminate();
  worker = undefined;
  for (const job of jobs.values()) {
    clearTimeout(job.timer);
    job.done();
  }
  jobs.clear();
}
export function highlight(text: string, language: string): Promise<Root | undefined> {
  if (!language || text.length > 100000) return Promise.resolve(undefined);
  try {
    if (!worker) {
      worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<{ id: number; tree?: Root }>) => {
        const job = jobs.get(data.id);
        if (job) {
          clearTimeout(job.timer);
          jobs.delete(data.id);
          job.done(data.tree);
        }
      };
      worker.onerror = reset;
    }
    const id = ++next;
    return new Promise((done) => {
      jobs.set(id, { done, timer: setTimeout(reset, 5000) });
      try {
        worker!.postMessage({ id, text, language });
      } catch {
        reset();
      }
    });
  } catch {
    reset();
    return Promise.resolve(undefined);
  }
}
