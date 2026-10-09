import { describe, expect, it } from 'vitest';
import {
  executionContext,
  executionTranscript,
} from '../../../electron/core/runtime/execution-evidence';
import type { Message } from '../../../src/shared/types';
import { portableHistory } from '../../../electron/core/runtime/history';

const receipt = (
  toolName: string,
  content: string,
  status: Message['status'] = 'complete',
): Message => ({
  id: 'tool',
  sessionId: 's',
  runId: 'new-run',
  createdAt: 1,
  role: 'tool',
  toolName,
  content,
  status,
});
describe('execution evidence transcript', () => {
  it('keeps actual tool identity and result status separate from assistant prose', () => {
    const records = executionTranscript(
      portableHistory(
        [
          receipt('content_list', '{"documents":[]}'),
          { ...receipt('', '已写入十章'), role: 'assistant' },
          receipt('client_change', '用户未批准', 'error'),
        ],
        100000,
      ),
    )
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      tool: 'content_list',
      status: 'complete',
      evidence: 'actual-tool-result',
    });
    expect(records[1]).toMatchObject({ evidence: 'assistant-text-not-execution-proof' });
    expect(records[2]).toMatchObject({ runId: 'new-run', status: 'error' });
    expect(executionContext('full-access')).toContain('自动批准');
    expect(executionContext('read-only')).toContain('不得执行写操作');
  });
});
