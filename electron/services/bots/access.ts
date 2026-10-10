import type {
  BotConfig,
  BotExecutionContext,
  PermissionMode,
  Session,
} from '../../../src/shared/types';
import type { Store } from '../storage/store';
import { botSettings } from './settings';

export function activeBot(store: Store, context: BotExecutionContext): BotConfig {
  const bot = store.list<BotConfig>('bot').find((b) => b.id === context.botId);
  if (!bot || !bot.allowedSenders.includes(context.sender))
    throw new Error('机器人连接或用户授权已失效');
  if (context.group && !bot.allowedChats.includes(context.chat))
    throw new Error('机器人群授权已失效');
  return bot;
}
export function botSessions(store: Store, context: BotExecutionContext): Session[] {
  activeBot(store, context);
  const settings = botSettings(store);
  return store.list<Session>('session').filter((s) => {
    if (s.parentId || s.memoryJob || s.knowledgeJob || s.automationJob) return false;
    if (s.botConversation) return s.id === context.conversationId;
    return settings.mode === 'workbench';
  });
}
export function assertBotSession(store: Store, context: BotExecutionContext, id: string) {
  const session = botSessions(store, context).find((s) => s.id === id);
  if (!session) throw new Error('此会话不在机器人的授权范围内');
  return session;
}
export function botPermission(
  store: Store,
  context: BotExecutionContext,
  local: PermissionMode,
): PermissionMode {
  activeBot(store, context);
  const settings = botSettings(store);
  if (settings.mode === 'chat') return 'read-only';
  const permission = settings.permission;
  const rank: PermissionMode[] = ['read-only', 'ask', 'full-access'];
  return rank[Math.min(rank.indexOf(local), rank.indexOf(permission))];
}
