import { botSettings } from './settings';
import { assertBotSession } from './access';
import type { BotConfig, Run } from '../../../src/shared/types';
import type { Lifecycle } from '../../core/application-events';
import type { Store } from '../storage/store';

/** Routes only runs explicitly started from a remote message, never all session activity. */
export class BotTaskReplies {
  private pending = new Map<
    string,
    {
      botId: string;
      sender: string;
      sessionId: string;
      reply: (text: string) => Promise<void>;
      delivered: Set<string>;
      stopTyping: () => void;
    }
  >();
  constructor(
    private store: Store,
    private list: () => BotConfig[],
    private changed: () => void,
  ) {}
  register(
    runId: string,
    botId: string,
    sender: string,
    sessionId: string,
    reply: (text: string) => Promise<void>,
    typing?: (active: boolean) => Promise<void>,
  ) {
    let stopped = false;
    const pulse = () => {
      if (!stopped) void typing?.(true).catch(() => {});
    };
    const timer = typing ? setInterval(pulse, 8000) : undefined;
    timer?.unref?.();
    const stopTyping = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      void typing?.(false).catch(() => {});
    };
    this.pending.set(runId, { botId, sender, sessionId, reply, delivered: new Set(), stopTyping });
    pulse();
  }
  remove(botId?: string) {
    for (const [id, item] of this.pending)
      if (!botId || item.botId === botId) {
        item.stopTyping();
        this.pending.delete(id);
      }
  }
  async notify(run: Run, event: Lifecycle) {
    const rootId = run.botContext?.rootRunId ?? run.id;
    const item = this.pending.get(rootId);
    if (!item || item.delivered.has(run.id)) return;
    if (rootId === run.id && item.sessionId !== run.sessionId) return;
    const bot = this.list().find((b) => b.id === item.botId);
    if (!bot || !bot.allowedSenders.includes(item.sender)) {
      item.stopTyping();
      this.pending.delete(rootId);
      return;
    }
    if (run.botContext) {
      if (
        run.botContext.botId !== item.botId ||
        run.botContext.sender !== item.sender ||
        run.botContext.conversationId !== item.sessionId
      )
        return;
      try {
        assertBotSession(this.store, run.botContext, run.sessionId);
      } catch {
        item.stopTyping();
        this.pending.delete(rootId);
        return;
      }
      if (rootId !== run.id && botSettings(this.store).permission === 'read-only') return;
    } else if (
      botSettings(this.store).mode === 'chat' ||
      botSettings(this.store).permission === 'read-only'
    )
      return;
    if (event === 'approval') item.stopTyping();
    if (event !== 'approval') {
      item.delivered.add(run.id);
      const children = this.store
        .list<Run>('run')
        .filter((r) => r.botContext?.rootRunId === rootId);
      if (item.delivered.has(rootId) && children.every((r) => item.delivered.has(r.id))) {
        item.stopTyping();
        this.pending.delete(rootId);
      }
    }
    const text =
      event === 'approval'
        ? '此任务需要批准，请回到同舟处理。'
        : event === 'completed'
          ? this.store
              .messages(run.sessionId)
              .filter(
                (m) => m.runId === run.id && m.role === 'assistant' && m.status === 'complete',
              )
              .map((m) => m.content)
              .filter(Boolean)
              .join('\n\n') || '任务已完成，请在同舟查看结果。'
          : event === 'interrupted'
            ? '任务已停止。'
            : '任务执行失败，请在同舟查看详情。';
    try {
      const prefix =
        rootId !== run.id
          ? `「${this.store.get<{ title: string }>('session', run.sessionId).title}」\n`
          : '';
      await item.reply((prefix + text).slice(0, 30_000));
    } catch {
      const current = this.list().find((b) => b.id === item.botId);
      if (current) {
        this.store.put('bot', {
          ...current,
          hasSecret: undefined,
          status: 'error',
          error: '任务结果未能发送到机器人聊天，请在同舟查看',
        });
        this.changed();
      }
    }
  }
}
