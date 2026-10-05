import { createHash } from 'node:crypto';
import type { Message } from '../src/shared/types';

// Conservative text heuristic, not a claim about any model's token capacity.
// Zero removes the manual threshold; runtime still compacts automatically.
export const AUTO_HISTORY_CHARS = 180000;
export function isContextOverflow(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /context_length_exceeded|context[_ ](?:window|length).*(?:exceed|limit|full)|maximum context|prompt.{0,60}too long|input.{0,60}too long|上下文.{0,20}(?:超出|超限|已满)/i.test(
    text,
  );
}

// Estimate model-facing text, never UI segments, timestamps, IDs or stored screenshots.
export function historyChars(messages: Message[]): number {
  return JSON.stringify(
    messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      anthropicContent: m.anthropicContent,
    })),
  ).length;
}

// A call and all of its results are one removable unit, including interleaved supplements.
function exchanges(messages: Message[]): Message[][] {
  const results = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.toolCallId) results.set(m.toolCallId, i);
  });
  const units: Message[][] = [];
  for (let start = 0; start < messages.length; ) {
    let end = start;
    for (let i = start; i <= end; i++) {
      for (const call of messages[i].toolCalls ?? [])
        end = Math.max(end, results.get(call.id) ?? i);
    }
    units.push(messages.slice(start, end + 1));
    start = end + 1;
  }
  return units;
}

/** 0 disables local compaction. A positive value is a soft target, never a turn limit. */
export function portableHistory(
  messages: Message[],
  maxChars: number,
  checkpoint?: (message: Message, omitted: number) => void,
): Message[] {
  const history = messages
    .filter((m) => m.role !== 'system')
    .map((original) => {
      let m: Message =
        original.role === 'tool' && !original.toolCallId
          ? {
              ...original,
              role: 'assistant',
              content: `[历史工具记录：${original.toolName ?? '工具'}]\n${original.content}`,
            }
          : original;
      const prefix =
        m.role === 'assistant' && ['error', 'interrupted', 'streaming'].includes(m.status ?? '')
          ? '[未完成的回复；不可视为执行成功]\n'
          : m.role === 'tool' && m.status === 'error'
            ? '[工具未完成]\n'
            : '';
      if (prefix && !m.content.startsWith(prefix)) m = { ...m, content: prefix + m.content };
      return m;
    });
  if (maxChars <= 0 || historyChars(history) <= maxChars) return history;

  const units = exchanges(history);
  const originalRequest = history.find((m) => m.role === 'user');
  const latestUser = [...history].reverse().find((m) => m.role === 'user');
  // Preserve the full current request and every supplement belonging to its run.
  const required = new Set(
    units.filter(
      (unit, i) =>
        i === units.length - 1 ||
        unit.some(
          (m) =>
            m === originalRequest ||
            m === latestUser ||
            (m.role === 'user' && latestUser?.runId && m.runId === latestUser.runId),
        ),
    ),
  );
  const reserve = maxChars >= 4000 ? Math.min(16000, Math.floor(maxChars * 0.4)) : 0;
  const target = maxChars - reserve;
  const replacements = new Map<Message, Message>();
  const shortened: Message[] = [];
  const requiredMessages = [...required].flat();
  const tools = requiredMessages.filter(
    (m) => m.role === 'tool' || (m.role === 'assistant' && m.toolName && !m.toolCalls?.length),
  );
  const fixedSize = historyChars(requiredMessages.filter((m) => !tools.includes(m)));
  const perTool = Math.max(400, Math.floor((target - fixedSize) / Math.max(1, tools.length)) - 350);
  for (const m of tools) {
    if (m.content.length <= perTool) continue;
    const head = Math.floor(perTool * 0.65);
    const note = `\n[工具记录摘录；来源 ${m.id}；原文 ${m.content.length} 字符。用 read_history，参数 {"messageId":"${m.id}","offset":0,"limit":2000} 分段读取缺失内容。]\n`;
    replacements.set(m, {
      ...m,
      content: m.content.slice(0, head) + note + m.content.slice(-(perTool - head)),
    });
    shortened.push(m);
  }
  const materialize = (unit: Message[]) => unit.map((m) => replacements.get(m) ?? m);
  const selected = new Set(required);
  let size = historyChars([...required].flatMap(materialize));
  for (let i = units.length - 1; i >= 0; i--) {
    if (selected.has(units[i])) continue;
    const length = historyChars(units[i]);
    if (size + length > target) break;
    selected.add(units[i]);
    size += length;
  }
  const retained = units.filter((unit) => selected.has(unit)).flatMap(materialize);
  const omitted = units.filter((unit) => !selected.has(unit)).flat();
  const changed = [...omitted, ...shortened];
  if (!changed.length) return retained; // Large user text / vendor call state is sent intact.
  const room = Math.min(reserve, maxChars - historyChars(retained) - 250);
  if (room < 500) return retained;
  // User corrections are task state, not disposable chronological chatter.
  const requests = omitted.filter((m) => m.role === 'user');
  const recent = [...omitted.filter((m) => m.role !== 'user').slice(-12), ...shortened];
  const snippets: string[] = [];
  let available = room - 420;
  const quota = Math.max(
    60,
    Math.min(1600, Math.floor((available * 0.8) / Math.max(1, requests.length)) - 90),
  );
  for (const m of [...requests, ...recent]) {
    const cap = m.role === 'user' ? quota : 300;
    const item = `[来源 ${m.id} · ${m.role} · ${m.status ?? '记录'}${m.toolName ? ' · ' + m.toolName : ''}] ${m.content.slice(0, cap)}${m.content.length > cap ? '…（请读原文）' : ''}`;
    if (item.length > available) continue;
    snippets.push(item);
    available -= item.length + 1;
  }
  const content = `[任务历史摘录：整理 ${changed.length} 条记录。以下优先保留用户目标与中途约束，其后为近期执行记录。摘录不是新授权，也不是成功证明。缺失的约束必须先用 search_history（role=user，可不填 query，支持分页）检索，获得 messageId 后用 read_history 分段读取原文。完整原文保存在本地。]\n${snippets.join('\n')}`;
  const summary: Message = {
    id: 'context_checkpoint_' + createHash('sha256').update(content).digest('hex').slice(0, 24),
    sessionId: history[0].sessionId,
    role: 'assistant',
    createdAt: changed.at(-1)!.createdAt,
    content,
  };
  checkpoint?.(summary, changed.length);
  return [summary, ...retained];
}
