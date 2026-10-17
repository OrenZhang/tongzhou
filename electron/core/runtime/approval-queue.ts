import { randomUUID } from 'node:crypto';
import type { Approval, AppEvent, Run, Session } from '../../../src/shared/types';
import type { Store } from '../../services/storage/store';
import type { QuestionAnswers, QuestionRequest } from '../../../src/shared/agent-execution';
import { questionsSchema, validateQuestionAnswers } from './question-input';

/** Owns pending decisions, their timers and abort listeners independently of task execution. */
export class ApprovalQueue {
  private entries = new Map<
    string,
    {
      value: Approval;
      resolve: (answer: boolean | QuestionAnswers | null, status?: string) => void;
    }
  >();
  private closed = false;

  constructor(
    private store: Store,
    private emit: (event: AppEvent) => void,
    private changed: () => void,
    private requested: (run: Run, approvalId: string) => void,
  ) {
    // RPC requests cannot survive a process restart. Preserve their record, not their callback.
    for (const request of store.list<any>('userQuestion'))
      if (request.status === 'pending')
        store.put('userQuestion', { ...request, status: 'cancelled' });
  }

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
    return this.enqueue(
      { id: randomUUID(), sessionId, title, detail },
      signal,
      10 * 60 * 1000,
    ).then((answer) => answer === true);
  }

  question(sessionId: string, runId: string, params: QuestionRequest, signal: AbortSignal) {
    const timeout = params.isBlocking
      ? 10 * 60 * 1000
      : Math.max(0, Math.min(params.autoResolutionMs ?? 30000, 10 * 60 * 1000));
    const value: Approval = {
      id: randomUUID(),
      sessionId,
      runId,
      threadId: params.threadId,
      kind: 'question',
      title: '需要你的补充',
      detail: '',
      questions: questionsSchema.parse(params.questions),
      isBlocking: params.isBlocking,
      expiresAt: Date.now() + timeout,
    };
    return this.enqueue(value, signal, timeout).then((answer) =>
      typeof answer === 'object' ? answer : null,
    );
  }

  private enqueue(
    value: Approval,
    signal: AbortSignal,
    timeout: number,
  ): Promise<boolean | QuestionAnswers | null> {
    if (this.closed || signal.aborted) return Promise.resolve(null);
    if (value.kind === 'question') this.store.put('userQuestion', { ...value, status: 'pending' });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (answer: boolean | QuestionAnswers | null, status = 'answered') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.entries.delete(value.id);
        try {
          if (value.kind === 'question') this.store.put('userQuestion', { ...value, status });
        } catch (error) {
          reject(error);
        }
        this.changed();
        resolve(answer);
      };
      const abort = () => finish(null, 'cancelled');
      const timer = setTimeout(() => finish(null, 'expired'), timeout);
      signal.addEventListener('abort', abort, { once: true });
      this.entries.set(value.id, { value, resolve: finish });
      this.emit({ type: 'approval', approval: value });
      const run = this.store
        .list<Run>('run')
        .find((r) => r.sessionId === value.sessionId && r.status === 'running');
      if (run) this.requested(run, value.id);
      this.changed();
    });
  }

  approve(id: string, allow: boolean) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('审批已失效');
    if (entry.value.kind === 'question') throw new Error('这是追问，请填写回答');
    entry.resolve(allow);
  }

  answer(id: string, answers: unknown) {
    const entry = this.entries.get(id);
    if (!entry || entry.value.kind !== 'question') throw new Error('追问已失效');
    const reply = validateQuestionAnswers(entry.value.questions!, answers);
    entry.resolve(reply, reply === null ? 'cancelled' : 'answered');
  }

  dispose() {
    this.closed = true;
    for (const entry of [...this.entries.values()]) entry.resolve(null, 'cancelled');
  }
  cancelSession(id: string) {
    for (const entry of [...this.entries.values()])
      if (entry.value.sessionId === id) entry.resolve(null, 'cancelled');
  }
}
