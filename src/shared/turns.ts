import type { Message, Run, RunEvent } from './types';

export interface ConversationTurn {
  key: string;
  runId?: string;
  run?: Run;
  messages: Message[];
  events: RunEvent[];
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
