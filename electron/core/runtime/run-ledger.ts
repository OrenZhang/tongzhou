import { randomUUID } from 'node:crypto';
import type { AppEvent, Message, Run, RunEvent } from '../../../src/shared/types';
import type { Store } from '../../services/storage/store';

/** Owns ordered messages and progress persistence for concurrent runs. */
export class RunLedger {
  constructor(
    private store: Store,
    private emit: (event: AppEvent) => void,
    private isStopping: () => boolean,
  ) {}
  private eventSequences = new Map<string, number>();
  private reasoning = new Map<string, RunEvent>();
  private toolOutput = new Map<string, RunEvent>();
  private progressSaved = new Map<string, number>();
  private nextSequence(runId: string) {
    const seq = (this.eventSequences.get(runId) ?? 0) + 1;
    this.eventSequences.set(runId, seq);
    return seq;
  }
  flushProgress(runId: string) {
    for (const cache of [this.reasoning, this.toolOutput]) {
      const event = cache.get(runId);
      if (event) {
        this.store.put('runEvent', event);
        this.emit({ type: 'run-event', event });
        cache.delete(runId);
      }
    }
    this.progressSaved.delete(runId);
    this.progressSaved.delete(runId + ':tool');
  }
  appendText(message: Message, text: string) {
    if (!text) return;
    const start = message.content.length;
    message.content += text;
    if (!message.runId) return;
    message.segments ??= [];
    const last = message.segments.at(-1);
    if (last && last.seq === this.eventSequences.get(message.runId))
      last.end = message.content.length;
    else
      message.segments.push({
        seq: this.nextSequence(message.runId),
        start,
        end: message.content.length,
        time: Date.now(),
      });
  }
  finishText(message: Message, text: string) {
    if (text.startsWith(message.content))
      this.appendText(message, text.slice(message.content.length));
    else {
      message.content = '';
      message.segments = [];
      this.appendText(message, text);
    }
  }
  progress(run: Run, type: RunEvent['type'], text: string) {
    if (!text || this.isStopping()) return;
    if (type === 'phase') {
      if (run.phase === text) return;
      this.flushProgress(run.id);
      run.phase = text;
      this.store.put('run', run);
    }
    let event =
      type === 'reasoning'
        ? this.reasoning.get(run.id)
        : type === 'tool'
          ? this.toolOutput.get(run.id)
          : undefined;
    if (event) {
      if (event.text.length >= 64000) return;
      event = {
        ...event,
        text: (event.text + (type === 'tool' ? '\n' : '') + text).slice(0, 64000),
      };
    } else {
      const seq = this.nextSequence(run.id);
      event = {
        id: randomUUID(),
        sessionId: run.sessionId,
        runId: run.id,
        seq,
        time: Date.now(),
        type,
        text: text.slice(0, 64000),
      };
    }
    if (type === 'reasoning') {
      this.reasoning.set(run.id, event);
      if (Date.now() - (this.progressSaved.get(run.id) ?? 0) < 80) return;
      this.progressSaved.set(run.id, Date.now());
    }
    if (type === 'tool') {
      this.toolOutput.set(run.id, event);
      if (Date.now() - (this.progressSaved.get(run.id + ':tool') ?? 0) < 80) return;
      this.progressSaved.set(run.id + ':tool', Date.now());
    }
    this.store.put('runEvent', event);
    this.emit({ type: 'run-event', event });
  }
  message(message: Message) {
    if (message.runId && message.role !== 'assistant' && message.sequence === undefined) {
      this.flushProgress(message.runId);
      message.sequence = this.nextSequence(message.runId);
    }
    this.store.message(message);
    this.emit({ type: 'message', message });
  }
  add(
    sessionId: string,
    role: Message['role'],
    content: string,
    extra: Partial<Message> = {},
  ): Message {
    const m: Message = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      createdAt: Date.now(),
      status: 'complete',
      ...extra,
    };
    this.message(m);
    return m;
  }
  replaceUnanswered(message: Message, previousRunId: string) {
    message.sequence = this.nextSequence(message.runId!);
    const removed = this.store.replaceUnansweredMessage(message, previousRunId);
    this.emit({ type: 'messages-removed', sessionId: message.sessionId, ids: removed });
    this.emit({ type: 'message', message });
  }
  complete(runId: string) {
    this.flushProgress(runId);
    this.eventSequences.delete(runId);
  }
}
