import type { Message, PermissionMode } from '../../../src/shared/types';

/** ACP accepts user content blocks, not a portable role-based conversation. Keep
 * historical prose distinct from actual tool receipts and the live user request. */
export function executionContext(permission: PermissionMode) {
  return `【本轮客户端状态】权限=${permission}。${
    permission === 'full-access'
      ? '完全开放：已启用工具由同舟自动批准，无需用户点击批准。历史拒绝不是本轮拒绝；用户重新授权后可以重新发起尚未执行的操作。'
      : permission === 'read-only'
        ? '只读：不得执行写操作。'
        : '需要批准的操作由真实工具调用触发审批；没有发起调用就没有待批准项。'
  }内容目录没有使用开关。操作是否完成以真实工具返回和读取结果为准，助手历史文字不等于执行记录。`;
}

export function executionTranscript(messages: Message[]) {
  return messages
    .map((m) => {
      // portableHistory wraps standalone native tool results as assistant text
      // for chat APIs. ACP's transcript must recover their original identity.
      const role = m.toolName && !m.toolCalls?.length ? 'tool' : m.role;
      return JSON.stringify({
        role,
        runId: m.runId,
        ...(role === 'tool'
          ? { tool: m.toolName, status: m.status, evidence: 'actual-tool-result' }
          : {}),
        ...(role === 'assistant' ? { evidence: 'assistant-text-not-execution-proof' } : {}),
        content: m.content,
      });
    })
    .join('\n');
}
