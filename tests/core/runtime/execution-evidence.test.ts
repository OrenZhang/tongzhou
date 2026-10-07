import { describe, expect, it } from 'vitest';
import {
  executionContext,
  executionTranscript,
  unsupportedExecutionClaims,
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
const check = (text: string, receipts: Message[] = []) =>
  unsupportedExecutionClaims(text, receipts, () => false);

describe('execution evidence reconciliation', () => {
  it('detects the observed empty-list write claim and invented artifacts', () => {
    expect(
      check('10章内容都成功写入了内容目录。', [receipt('content_list', '{"documents":[]}')]),
    ).toHaveLength(1);
    expect(check('已交付 [文档](artifact://d2c1a5e9-7e63-4a8a-bd3b-9a8c2c8b9c11)')).toHaveLength(1);
    expect(
      check('技能已创建成功。', [receipt('client_catalog', '{"available":true}')]),
    ).toHaveLength(1);
    expect(check('createSkill 再次被审批拒绝。')).toHaveLength(1);
  });
  it('accepts actual write/read evidence and actual denials', () => {
    expect(
      check('正文已写入。', [receipt('content_write', '{"id":"document","version":1}')]),
    ).toEqual([]);
    expect(check('文档已经保存。', [receipt('content_read', '{"content":"正文"}')])).toEqual([]);
    expect(
      check('技能已创建。', [receipt('client_change', '{"method":"createSkill"}\n{"id":"skill"}')]),
    ).toEqual([]);
    expect(
      check('本次仍被审批拒绝。', [receipt('client_change', '用户未批准此操作', 'error')]),
    ).toEqual([]);
    expect(
      check('正文已写入。', [receipt('content_write', '用户未批准此操作', 'error')]),
    ).toHaveLength(1);
  });
  it('does not intercept questions, plans, quotes, code, corrections or historical reports', () => {
    for (const text of [
      '你好',
      '我将保存文档。',
      '文档尚未保存。',
      '之前已保存文档。',
      '如果文档已保存，可以读取。',
      '上一轮技能被拒绝。',
      '当前没有被审批拒绝。',
      '刚才误称正文已写入，实际未执行。',
      '> 文档已写入。',
      '```md\n文档已写入。\n```',
    ])
      expect(check(text), text).toEqual([]);
  });
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
