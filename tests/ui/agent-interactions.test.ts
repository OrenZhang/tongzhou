import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { QuestionCard } from '../../src/features/chat/QuestionCard';
import { AgentActivity } from '../../src/features/chat/AgentActivity';
import { finalTurnEntry, turnEntries } from '../../src/shared/turns';
import type { Message } from '../../src/shared/types';
import { nativeToolReceipt } from '../../electron/core/codex/native-events';

it('renders unselected questions, compact actions and protected secret fields', () => {
  const html = renderToStaticMarkup(
    createElement(QuestionCard, {
      request: {
        id: 'q',
        sessionId: 'chat',
        title: '问题',
        detail: '',
        kind: 'question',
        questions: [
          {
            id: 'secret',
            header: '输入',
            question: 'fixture question',
            isSecret: true,
            isOther: true,
            options: null,
          },
        ],
      },
      onAnswer: async () => {},
    }),
  );
  expect(html).toContain('type="password"');
  expect(html).toContain('提交回答');
  expect(html).toContain('disabled=""');
  expect(html).not.toContain('checked=""');
});
it('shows child failures and removes task controls after parent completion', () => {
  const html = renderToStaticMarkup(
    createElement(AgentActivity, {
      agents: [
        {
          threadId: 'child',
          parentThreadId: 'root',
          name: '审阅',
          status: 'failed',
          message: 'fixture failure',
        },
      ],
      active: false,
      onControl: async () => {},
    }),
  );
  expect(html).toContain('失败');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('parentThreadId');
});
it('uses native reply phases and keeps structured observations out of the transcript', () => {
  const message = (id: string, phase: Message['phase']): Message => ({
    id,
    phase,
    role: 'assistant',
    content: id,
    sessionId: 'chat',
    createdAt: 1,
  });
  const entries = turnEntries({
    key: 'run',
    messages: [message('final', 'final_answer'), message('late-progress', 'commentary')],
    events: [
      {
        id: 'observe',
        runId: 'run',
        sessionId: 'chat',
        time: 1,
        seq: 1,
        type: 'observation',
        text: '{"actualModel":"gpt-6-sol"}',
      },
    ],
  });
  expect(finalTurnEntry(entries, false)?.key).toBe('final');
  expect(finalTurnEntry(entries.slice(1), false)).toBeUndefined();
  expect(entries).toHaveLength(2);
});
it('keeps failed and declined native operations distinct from successful receipts', () => {
  expect(
    nativeToolReceipt({
      type: 'commandExecution',
      command: 'fixture',
      status: 'completed',
      exitCode: 1,
    })?.status,
  ).toBe('error');
  expect(nativeToolReceipt({ type: 'fileChange', status: 'declined', changes: [] })?.status).toBe(
    'error',
  );
  expect(
    nativeToolReceipt({
      type: 'mcpToolCall',
      status: 'completed',
      result: { isError: true },
      error: null,
    })?.status,
  ).toBe('error');
});
