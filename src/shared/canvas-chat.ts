import type { Message } from './types';
import { canvasChatMarker } from './canvas-collaboration';

export function canvasChatTurns(messages: Message[], canvasId: string) {
  return messages
    .filter((m) => m.role === 'user' && m.content.startsWith(canvasChatMarker(canvasId)))
    .map((user) => ({
      user,
      replies: user.runId
        ? messages.filter(
            (m) =>
              m.runId === user.runId &&
              m.role === 'assistant' &&
              (m.content || m.artifactIds?.length),
          )
        : [],
      tools: user.runId ? messages.filter((m) => m.runId === user.runId && m.role === 'tool') : [],
    }));
}

export function canvasChatError(error: string) {
  if (/参数不完整|invalid.*json|malformed.*argument/i.test(error))
    return '这次修改的参数格式不完整，未提交该次操作。可以继续完成，助手会先核对画布当前状态。';
  if (/上限|output.*limit|max.*tokens/i.test(error))
    return '这次输出超过模型上限。可以缩小需求后继续，已完成的操作会保留。';
  if (/stream disconnected|中断|断开|fetch failed|timeout/i.test(error))
    return '回复中断了。已完成的操作会保留，可以继续完成剩余需求。';
  return '这次需求未能完成。查看错误详情后，可修改需求或继续处理。';
}

export const canvasToolLabels: Record<string, string> = {
  canvas_read: '查看画布',
  canvas_list: '检查可用能力',
  canvas_apply: '更新节点与连线',
  canvas_execute: '启动工作流',
  canvas_cancel: '停止工作流',
};
