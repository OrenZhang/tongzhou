import type { Message, Run } from '../../../src/shared/types';

export interface EngineSegment {
  id: string;
  sessionId: string;
  threadId: string;
  fingerprint?: string;
  completed?: boolean;
  state?: 'running' | 'completed' | 'failed' | 'interrupted';
  usageTotal?: { inputTokens: number; outputTokens: number };
  lastMessageId?: string;
}

/** Only resume the native thread that still owns the immediately preceding history. */
export function resumableSegment(
  segments: EngineSegment[],
  messages: Message[],
  run: Run,
  fingerprint: string,
): EngineSegment | undefined {
  // Editing replaces a prompt in history; a native rollout still contains the old one.
  if (run.retryOf) return;
  const start = messages.findIndex((m) => m.runId === run.id);
  if (start < 1 || messages.slice(start).some((m) => m.runId !== run.id || m.role !== 'user'))
    return;
  const history = messages.slice(0, start);
  const previous = history.at(-1)!;
  const segment = segments.find(
    (s) =>
      s.id === previous.runId &&
      s.sessionId === run.sessionId &&
      s.fingerprint === fingerprint &&
      !!s.threadId &&
      (s.completed || s.state === 'failed' || s.state === 'interrupted'),
  );
  if (!segment?.lastMessageId) return;
  const boundary = history.findIndex((m) => m.id === segment.lastMessageId);
  // The scheduler can append a terminal error after execution has saved its snapshot.
  // Any other new content needs a fresh transcript, including imports and supplements.
  if (
    boundary < 0 ||
    history.slice(boundary + 1).some((m) => m.runId !== segment.id || m.role !== 'system')
  )
    return;
  return segment;
}
