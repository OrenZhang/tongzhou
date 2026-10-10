import { describe, expect, it } from 'vitest';
import {
  conversationTurns,
  processGroups,
  turnEntries,
  finalTurnEntry,
  formatDuration,
} from '../../src/shared/turns';
import type { Message, Run, RunEvent } from '../../src/shared/types';

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
  it('retains actionable notices in their recorded order', () => {
    const t = conversationTurns(
      'chat',
      [message('ask', 'user', 'r')],
      [run('r')],
      [
        {
          ...event('compacted', 'r', 1),
          type: 'notice',
          text: 'Codex 已完成上下文压缩，继续当前任务；完整历史仍保留在本地。',
        },
        {
          ...event('warning', 'r', 2),
          type: 'notice',
          text: '此模型不能关闭思考，已使用支持的最低强度。',
        },
      ],
    )[0];
    expect(turnEntries(t).map((entry) => entry.key)).toEqual(['compacted', 'warning']);
    expect(t.events).toHaveLength(2);
  });
  it('groups consecutive tools, removes duplicate labels and keeps reasoning boundaries', () => {
    const t = conversationTurns(
      'chat',
      [
        message('ask', 'user', 'r'),
        { ...message('tool1', 'tool', 'r'), toolName: 'read_file', sequence: 2 },
        { ...message('tool2', 'tool', 'r'), toolName: 'list_files', sequence: 4 },
        { ...message('tool3', 'tool', 'r'), toolName: 'read_file', sequence: 6, status: 'error' },
      ],
      [run('r')],
      [
        { ...event('start1', 'r', 1), type: 'tool', text: 'read_file' },
        { ...event('start2', 'r', 3), type: 'tool', text: 'list_files' },
        event('thinking', 'r', 5),
      ],
    )[0];
    const groups = processGroups(turnEntries(t));
    expect(groups.map((g) => [g.tools, g.entries.length])).toEqual([
      [true, 2],
      [false, 1],
      [true, 1],
    ]);
    expect(groups[0].entries.map((e) => e.key)).toEqual(['tool1', 'tool2']);
    expect(groups[2].entries[0]).toMatchObject({ message: { status: 'error' } });
  });
  it('interleaves reasoning and response segments without splitting protocol messages', () => {
    const reply = {
      ...message('reply', 'assistant', 'r1'),
      content: '先说明最后结果',
      segments: [
        { seq: 3, start: 0, end: 3, time: 5 },
        { seq: 8, start: 3, end: 7, time: 5 },
      ],
    };
    const t = conversationTurns(
      'chat',
      [message('ask', 'user', 'r1'), reply],
      [run('r1')],
      [event('think1', 'r1', 2), event('think2', 'r1', 7)],
    )[0];
    const entries = turnEntries(t);
    expect(entries.map((e) => ('event' in e ? e.event.text : e.text))).toEqual([
      'think1',
      '先说明',
      'think2',
      '最后结果',
    ]);
    expect(finalTurnEntry(entries, true)).toBeUndefined();
    expect(finalTurnEntry(entries, false)).toBe(entries[3]);
    expect(reply.content).toBe('先说明最后结果');
  });
  it('does not treat commentary before a tool or supplement as a final answer', () => {
    const t = conversationTurns(
      'chat',
      [
        message('ask', 'user', 'r1'),
        { ...message('interim', 'assistant', 'r1'), sequence: 2 },
        { ...message('tool', 'tool', 'r1'), sequence: 3 },
      ],
      [run('r1', 'failed')],
      [],
    )[0];
    expect(finalTurnEntry(turnEntries(t), false)).toBeUndefined();
    expect(formatDuration(1097000)).toBe('18分17秒');
    expect(formatDuration(3661000)).toBe('1小时1分1秒');
    expect(formatDuration(-1000)).toBe('0秒');
  });
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
  it('groups copied and branched records at user boundaries without merging separate runs', () => {
    const turns = conversationTurns(
      'chat',
      [
        message('copied-user', 'user'),
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
      ['copied-user', 'part1', 'part2'],
      ['another-user', 'reply'],
      ['modern', 'modern-reply'],
    ]);
  });
});
