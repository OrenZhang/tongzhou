import { randomUUID } from 'node:crypto';
import type { Approval, AppEvent, Run, Session } from '../../../src/shared/types';
import type { Store } from '../../services/storage/store';

/** Owns pending decisions, their timers and abort listeners independently of task execution. */
export class ApprovalQueue {
  private entries = new Map<string, { value: Approval; resolve: (allow: boolean) => void }>();
  private closed = false;

  constructor(
    private store: Store,
    private emit: (event: AppEvent) => void,
    private changed: () => void,
    private requested: (run: Run, approvalId: string) => void,
  ) {}

  snapshot() {
    return [...this.entries.values()].map((a) => a.value);
  }

  ask(
    sessionId: string,
    title: string,
    detail: string,
    signal: AbortSignal,
    force = false,
  ): Promise<boolean> {
    if (this.closed || signal.aborted) return Promise.resolve(false);
    if (this.store.list<Session>('session').some((s) => s.id === sessionId && s.memoryJob))
      return Promise.resolve(false);
    const current = this.store
      .list<Run>('run')
      .find((r) => r.sessionId === sessionId && r.status === 'running');
    if (!force && current?.config?.permission === 'full-access') return Promise.resolve(true);
    return new Promise((resolve) => {
      const value: Approval = { id: randomUUID(), sessionId, title, detail };
      let settled = false;
      const finish = (allow: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.entries.delete(value.id);
        this.changed();
        resolve(allow);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, 10 * 60 * 1000);
      signal.addEventListener('abort', abort, { once: true });
      this.entries.set(value.id, { value, resolve: finish });
      this.emit({ type: 'approval', approval: value });
      const run = this.store
        .list<Run>('run')
        .find((r) => r.sessionId === sessionId && r.status === 'running');
      if (run) this.requested(run, value.id);
      this.changed();
    });
  }

  approve(id: string, allow: boolean) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('审批已失效');
    entry.resolve(allow);
  }

  dispose() {
    this.closed = true;
    for (const entry of [...this.entries.values()]) entry.resolve(false);
  }
}
