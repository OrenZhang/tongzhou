import { describe, expect, it } from 'vitest';
import { conversationTurns } from '../src/shared/turns';
import type { Message, Run, RunEvent } from '../src/shared/types';

const message = (
  id: string,
  role: Message['role'],
  runId?: string,
  sessionId = 'chat',
): Message => ({
  id,
  role,
  runId,
  sessionId,
  createdAt: 1,
  content: id,
});
const run = (id: string, status: Run['status'] = 'completed', sessionId = 'chat'): Run => ({
  id,
  sessionId,
  status,
  providerId: 'provider',
  model: 'model',
  agentName: '同舟',
  startedAt: 1,
  inputTokens: 0,
  outputTokens: 0,
});
const event = (id: string, runId: string, seq: number, sessionId = 'chat'): RunEvent => ({
  id,
  runId,
  seq,
  sessionId,
  time: 1,
  type: 'reasoning',
  text: id,
});

describe('conversation turn presentation', () => {
  it('keeps tool iterations and mid-run supplements in one turn without changing protocol messages', () => {
    const messages = [
      message('ask', 'user', 'r1'),
      message('before', 'assistant', 'r1'),
      message('tool', 'tool', 'r1'),
      message('extra', 'user', 'r1'),
      message('after', 'assistant', 'r1'),
      message('next', 'user', 'r2'),
      message('final', 'assistant', 'r2'),
    ];
    const original = JSON.stringify(messages);
    const turns = conversationTurns(
      'chat',
      messages,
      [run('r1'), run('r2')],
      [event('second', 'r1', 2), event('next-event', 'r2', 1), event('first', 'r1', 1)],
    );
    expect(turns).toHaveLength(2);
    expect(turns[0].messages.map((m) => m.id)).toEqual(['ask', 'before', 'tool', 'extra', 'after']);
    expect(turns[0].events.map((e) => e.id)).toEqual(['first', 'second']);
    expect(turns[1].events.map((e) => e.id)).toEqual(['next-event']);
    expect(JSON.stringify(messages)).toBe(original);
    expect(turns[0].messages[1]).toBe(messages[1]);
  });
  it('isolates messages, run status, and events during a session switch', () => {
    const turns = conversationTurns(
      'chat',
      [message('ours', 'user', 'r1'), message('other', 'assistant', 'r1', 'other')],
      [run('r1', 'completed'), run('r1', 'running', 'other')],
      [event('private', 'r1', 1, 'other')],
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].messages.map((m) => m.id)).toEqual(['ours']);
    expect(turns[0].run?.status).toBe('completed');
    expect(turns[0].events).toEqual([]);
  });
  it('retains the same turn identity when pagination restores the beginning of a run', () => {
    const all = [
      message('ask', 'user', 'r1'),
      message('part1', 'assistant', 'r1'),
      message('part2', 'assistant', 'r1'),
    ];
    const partial = conversationTurns('chat', all.slice(1), [], []);
    const full = conversationTurns('chat', all, [], []);
    expect(partial[0].key).toBe(full[0].key);
    expect(full).toHaveLength(1);
    expect(full[0].messages).toEqual(all);
  });
  it('shows a preparing run before text arrives but does not resurrect unloaded historical runs', () => {
    const turns = conversationTurns(
      'chat',
      [],
      [run('old'), run('active', 'running')],
      [event('old-event', 'old', 1), event('live-event', 'active', 1)],
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].runId).toBe('active');
    expect(turns[0].events.map((e) => e.id)).toEqual(['live-event']);
  });
  it('groups legacy and branched records at user boundaries without merging separate runs', () => {
    const turns = conversationTurns(
      'chat',
      [
        message('legacy-user', 'user'),
        message('part1', 'assistant'),
        message('part2', 'assistant'),
        message('another-user', 'user'),
        message('reply', 'assistant'),
        message('modern', 'user', 'r1'),
        message('modern-reply', 'assistant', 'r1'),
      ],
      [],
      [],
    );
    expect(turns.map((t) => t.messages.map((m) => m.id))).toEqual([
      ['legacy-user', 'part1', 'part2'],
      ['another-user', 'reply'],
      ['modern', 'modern-reply'],
    ]);
  });
});
