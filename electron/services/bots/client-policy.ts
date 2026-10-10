import { randomUUID } from 'node:crypto';
import type { BotExecutionContext, Run, RunInput, Session } from '../../../src/shared/types';
import type { ClientToolPolicy } from '../../core/tools/client-commands';
import type { Store } from '../storage/store';
import { activeBot, assertBotSession, botSessions } from './access';
import { botSettings } from './settings';

const sessionFirst = new Set([
  'messages',
  'readMessage',
  'runEvents',
  'updateSession',
  'cancel',
  'deleteSession',
  'branchSession',
  'exportSession',
]);
const blocked = new Set([
  'saveBot',
  'deleteBot',
  'restartBot',
  'cancelBotLogin',
  'saveBotSettings',
  'setDefaultPermission',
  'setSessionPermission',
  'approve',
  'enqueue',
  'team',
]);

/** Scope the ordinary client gateway, so remote chats reuse the same business handlers. */
export function botClientPolicy(
  store: Store,
  context: BotExecutionContext,
  runId: string,
  start: (input: RunInput) => string,
): ClientToolPolicy {
  const allowed = () => new Set(botSessions(store, context).map((s) => s.id));
  return {
    unavailable(method) {
      try {
        activeBot(store, context);
        if (blocked.has(method))
          return '此操作需在本机处理；跨会话任务请使用 run，不能自行修改机器人授权';
        if (botSettings(store).mode === 'chat') return '当前为仅聊天模式，不开放工作台工具';
      } catch (error) {
        return (error as Error).message;
      }
    },
    async invoke(method, args, invoke) {
      const bot = activeBot(store, context);
      if (botSettings(store).mode === 'chat') throw new Error('当前为仅聊天模式，不开放工作台工具');
      if (sessionFirst.has(method)) assertBotSession(store, context, args[0] as string);
      if (method === 'run') {
        if (botSettings(store).permission === 'read-only') throw new Error('此连接仅允许查询');
        const input = args[0] as RunInput;
        assertBotSession(store, context, input.sessionId);
        const settings = botSettings(store);
        const id = start({
          ...input,
          providerId: settings.providerId,
          model: settings.model,
          botContext: { ...context, rootRunId: context.rootRunId ?? runId },
        });
        return {
          runId: id,
          sessionId: input.sessionId,
          status: 'running',
          resultDelivery: '处理完成后系统会将此会话的结果回复到原机器人聊天。不要声称任务已完成。',
        };
      }
      const value = await invoke();
      if (method === 'createSession' || method === 'branchSession') {
        const session = value as Session;
        store.put('botSession', { id: randomUUID(), botId: bot.id, sessionId: session.id });
      }
      if (method === 'snapshot' || method === 'taskSnapshot') {
        const data = value as Record<string, any>;
        const ids = allowed();
        const filtered = {
          sessions: (data.sessions ?? []).filter((s: Session) => ids.has(s.id)),
          runs: (data.runs ?? [])
            .filter((r: Run) => ids.has(r.sessionId))
            .map(({ config, ...r }: Run) => r),
          pendingInputs: (data.pendingInputs ?? []).filter((p: any) => ids.has(p.sessionId)),
          approvals: (data.approvals ?? []).filter((a: any) => ids.has(a.sessionId)),
        };

        const { bots, channelAuth, authEvents, ...rest } = data;
        return { ...rest, ...filtered };
      }
      return value;
    },
  };
}
