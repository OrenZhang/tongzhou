import type { Snapshot, TongzhouAPI } from '../shared/types';

/** One writer prevents a late full snapshot from replacing a newer task update. */
export class SnapshotLoader {
  private pending = 0;
  private running?: Promise<void>;
  private disposed = false;
  constructor(
    private api: Pick<TongzhouAPI, 'snapshot' | 'taskSnapshot'>,
    private apply: (data: Partial<Snapshot>, full: boolean) => void,
  ) {}
  load(full = true): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending = Math.max(this.pending, full ? 2 : 1);
    return (this.running ??= this.drain().finally(() => {
      this.running = undefined;
    }));
  }
  private async drain() {
    while (this.pending && !this.disposed) {
      const full = this.pending === 2;
      this.pending = 0;
      const data = await (full ? this.api.snapshot() : this.api.taskSnapshot());
      if (!this.disposed) this.apply(data, full);
    }
  }
  dispose() {
    this.disposed = true;
    this.pending = 0;
  }
}
