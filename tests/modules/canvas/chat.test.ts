import { describe, it, expect } from 'vitest';
import { canvasChatTurns, canvasChatError } from '../../../src/shared/canvas-chat';
import type { Message } from '../../../src/shared/types';
const message = (id: string, role: Message['role'], content: string, runId?: string): Message => ({
  id,
  role,
  content,
  runId,
  createdAt: 1,
  sessionId: 's',
});
describe('canvas chat presentation', () => {
  it('groups commentary, tools and final text by request without mixing other conversations', () => {
    const turns = canvasChatTurns(
      [
        message('u1', 'user', '[画布助手:c]\n\n用户问题：小猫', 'r1'),
        message('a1', 'assistant', '先检查', 'r1'),
        { ...message('t1', 'tool', '{}', 'r1'), toolName: 'canvas_apply', status: 'error' },
        message('a2', 'assistant', '失败', 'r1'),
        message('u2', 'user', '[画布助手:other]\n\n用户问题：其他', 'r2'),
        message('a3', 'assistant', '其他回答', 'r2'),
        message('unbound', 'assistant', '非画布消息'),
      ],
      'c',
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].replies.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(turns[0].tools[0].status).toBe('error');
  });
  it('explains incomplete parameters without falsely claiming all prior work was lost', () => {
    expect(
      canvasChatError(
        'stream disconnected before completion: 工具 canvas_apply 参数不完整，未执行。',
      ),
    ).toContain('未提交该次操作');
    expect(canvasChatError('stream disconnected')).toContain('已完成的操作会保留');
  });
});
