import { expect, it } from 'vitest';
import { resumableSegment, type EngineSegment } from '../../../electron/core/codex/thread-state';
import type { Message, Run } from '../../../src/shared/types';

const run: Run = {
  id: 'next',
  sessionId: 'chat',
  providerId: 'p',
  model: 'm',
  agentName: 'a',
  status: 'running',
  startedAt: 2,
  inputTokens: 0,
  outputTokens: 0,
};
const msg = (id: string, role: Message['role'], runId?: string): Message => ({
  id,
  role,
  runId,
  sessionId: 'chat',
  content: id,
  createdAt: 1,
});
const segment: EngineSegment = {
  id: 'prior',
  sessionId: 'chat',
  threadId: 'native',
  fingerprint: 'same',
  state: 'failed',
  lastMessageId: 'receipt',
};
const history = [
  msg('ask', 'user', 'prior'),
  msg('receipt', 'tool', 'prior'),
  msg('terminal-error', 'system', 'prior'),
  msg('continue', 'user', 'next'),
];

it('accepts a persisted terminal notice after a native execution boundary', () => {
  expect(resumableSegment([segment], history, run, 'same')).toBe(segment);
});

it('rejects changed capabilities, rewritten requests and an unacknowledged execution', () => {
  expect(resumableSegment([segment], history, run, 'changed')).toBeUndefined();
  expect(
    resumableSegment([segment], history, { ...run, retryOf: 'prior' }, 'same'),
  ).toBeUndefined();
  expect(
    resumableSegment([{ ...segment, state: 'running' }], history, run, 'same'),
  ).toBeUndefined();
});

it('rejects new messages that were never sent to the saved native thread', () => {
  const current = history.at(-1)!;
  for (const addition of [msg('imported', 'assistant'), msg('supplement', 'user', 'prior')])
    expect(
      resumableSegment([segment], [...history.slice(0, -1), addition, current], run, 'same'),
    ).toBeUndefined();
  expect(
    resumableSegment([segment], [...history, msg('partial', 'assistant', 'next')], run, 'same'),
  ).toBeUndefined();
  expect(
    resumableSegment([{ ...segment, lastMessageId: 'deleted' }], history, run, 'same'),
  ).toBeUndefined();
});
