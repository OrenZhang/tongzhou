import type { Message } from '../../../src/shared/types';

/** Native execution receipts use the same audit messages as business tools. */
export function nativeToolReceipt(
  item: any,
): Pick<Message, 'content' | 'toolName' | 'status'> | undefined {
  if (item.type === 'commandExecution')
    return {
      content: `${item.command}\n\n${item.aggregatedOutput ?? ''}\nexit: ${item.exitCode}`,
      toolName: 'Codex · 终端',
      status: item.status === 'completed' && item.exitCode === 0 ? 'complete' : 'error',
    };
  if (item.type === 'fileChange')
    return {
      content: JSON.stringify(item.changes, null, 2) ?? '',
      toolName: 'Codex · 文件变更',
      status: item.status === 'completed' ? 'complete' : 'error',
    };
  if (item.type === 'mcpToolCall')
    return {
      content: JSON.stringify(item.result ?? item.error, null, 2) ?? '',
      toolName: `${item.server}/${item.tool}`,
      status:
        item.status === 'completed' && !item.error && !item.result?.isError ? 'complete' : 'error',
    };
}
