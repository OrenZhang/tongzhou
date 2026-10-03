import type { Message, Run, RunEvent } from './types';

export interface ConversationTurn {
  key: string;
  runId?: string;
  run?: Run;
  messages: Message[];
  events: RunEvent[];
}

export type TurnEntry =
  | { key: string; time: number; seq?: number; message: Message; text: string }
  | { key: string; time: number; seq?: number; event: RunEvent };

export function turnEntries(turn: ConversationTurn): TurnEntry[] {
  const entries: TurnEntry[] = [];
  const response = turn.messages[0]?.role === 'user' ? turn.messages.slice(1) : turn.messages;
  for (const message of response) {
    if (message.role === 'system') continue;
    if (turn.runId && message.role === 'assistant' && message.segments?.length) {
      for (const segment of message.segments) {
        const text = message.content.slice(segment.start, segment.end);
        if (text)
          entries.push({
            key: `${message.id}:${segment.seq}`,
            time: segment.time,
            seq: segment.seq,
            message,
            text,
          });
      }
    } else if (message.content) {
      entries.push({
        key: message.id,
        time: message.createdAt,
        seq: turn.runId ? message.sequence : undefined,
        message,
        text: message.content,
      });
    }
  }
  for (const event of turn.events) {
    if (event.type !== 'phase' && event.text.trim())
      entries.push({ key: event.id, time: event.time, seq: event.seq, event });
  }
  // Modern records share one sequence. Legacy records keep their original timestamps.
  return entries.sort((a, b) =>
    a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.time - b.time,
  );
}

export function finalTurnEntry(entries: TurnEntry[], active: boolean): TurnEntry | undefined {
  if (active) return;
  const last = entries.filter((entry) => 'message' in entry).at(-1);
  return last &&
    'message' in last &&
    last.message.role === 'assistant' &&
    !last.message.toolCalls?.length
    ? last
    : undefined;
}

export interface ProcessGroup {
  key: string;
  tools: boolean;
  entries: TurnEntry[];
}

export function processGroups(entries: TurnEntry[]): ProcessGroup[] {
  const visible = entries.filter((entry, i) => {
    const next = entries[i + 1];
    // The persisted result already identifies this call; do not show its start label twice.
    return !(
      'event' in entry &&
      entry.event.type === 'tool' &&
      next &&
      'message' in next &&
      next.message.role === 'tool' &&
      next.message.toolName === entry.event.text
    );
  });
  const groups: ProcessGroup[] = [];
  for (const entry of visible) {
    const tools = 'event' in entry ? entry.event.type === 'tool' : entry.message.role === 'tool';
    const previous = groups.at(-1);
    if (tools && previous?.tools) previous.entries.push(entry);
    else groups.push({ key: entry.key, tools, entries: [entry] });
  }
  return groups;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分${seconds % 60}秒`;
}

// Keep protocol messages intact. Only their presentation is grouped into a turn.
export function conversationTurns(
  sessionId: string,
  messages: Message[],
  runs: Run[],
  events: RunEvent[],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const byRun = new Map<string, ConversationTurn>();
  const sessionRuns = new Map(runs.filter((r) => r.sessionId === sessionId).map((r) => [r.id, r]));
  let legacy: ConversationTurn | undefined;
  for (const message of messages) {
    if (message.sessionId !== sessionId) continue;
    let turn: ConversationTurn;
    if (message.runId) {
      legacy = undefined;
      turn = byRun.get(message.runId) ?? {
        key: `${sessionId}:run:${message.runId}`,
        runId: message.runId,
        run: sessionRuns.get(message.runId),
        messages: [],
        events: [],
      };
      if (!byRun.has(message.runId)) {
        byRun.set(message.runId, turn);
        turns.push(turn);
      }
    } else {
      // Old/imported messages have no run ID: a user message starts a new turn.
      if (!legacy || message.role === 'user') {
        legacy = { key: `${sessionId}:message:${message.id}`, messages: [], events: [] };
        turns.push(legacy);
      }
      turn = legacy;
    }
    turn.messages.push(message);
  }
  // Show preparation immediately, including before a native engine emits text.
  for (const run of sessionRuns.values()) {
    if (run.status !== 'running' || byRun.has(run.id)) continue;
    const turn = {
      key: `${sessionId}:run:${run.id}`,
      runId: run.id,
      run,
      messages: [],
      events: [],
    };
    byRun.set(run.id, turn);
    turns.push(turn);
  }
  for (const event of events) {
    if (event.sessionId === sessionId) byRun.get(event.runId)?.events.push(event);
  }
  for (const turn of turns) turn.events.sort((a, b) => a.seq - b.seq);
  return turns;
}
