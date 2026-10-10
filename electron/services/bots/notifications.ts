import { createHash, randomUUID } from 'node:crypto';
import type { BotConfig, NotificationTarget } from '../../../src/shared/types';
import type { Store } from '../storage/store';
import { appFetch } from '../network/request-identity';
import { feishuHost, feishuToken } from '../channels/feishu';
import { WeixinApi, weixinBaseUrl } from './weixin/api';

const targetId = (botId: string, recipient: string, group: boolean) =>
  'bot-' +
  createHash('sha256')
    .update(JSON.stringify([botId, recipient, group]))
    .digest('hex');
export function botNotificationTargets(store: Store): NotificationTarget[] {
  return store.list<BotConfig>('bot').flatMap((bot) => {
    if (!['feishu', 'weixin'].includes(bot.kind)) return [];
    return [
      ...bot.allowedSenders.map((recipient) => ({ recipient, group: false })),
      ...(bot.kind === 'feishu'
        ? bot.allowedChats.map((recipient) => ({ recipient, group: true }))
        : []),
    ].map(({ recipient, group }) => {
      const id = targetId(bot.id, recipient, group);
      const available =
        store.hasSecret('bot_' + bot.id) &&
        (bot.kind !== 'weixin' || store.hasSecret('bot_context_' + id));
      return {
        id,
        name: `${bot.name} · ${group ? '群聊' : '私聊'} ${recipient}`,
        kind: bot.kind,
        botId: bot.id,
        recipient,
        group,
        available,
        ...(!available
          ? {
              reason:
                bot.kind === 'weixin'
                  ? '请先从微信向此机器人发送一条消息，建立回复上下文'
                  : '请先完成机器人授权',
            }
          : {}),
      };
    });
  });
}

/** Notification adapter reused by direct sends, run lifecycle rules and scheduled tasks. */
export class BotNotifications {
  constructor(
    private store: Store,
    private api: Pick<WeixinApi, 'request'> = new WeixinApi(),
    private fetcher: typeof fetch = appFetch,
    private getToken = feishuToken,
  ) {}
  list() {
    return botNotificationTargets(this.store);
  }
  remember(bot: BotConfig, sender: string, context?: string) {
    if (bot.kind === 'weixin' && context && bot.allowedSenders.includes(sender))
      this.store.saveSecret('bot_context_' + targetId(bot.id, sender, false), context);
  }
  clear(bot: BotConfig) {
    for (const user of bot.allowedSenders)
      this.store.saveSecret('bot_context_' + targetId(bot.id, user, false), undefined, true);
  }
  async send(id: string, text: string, signal: AbortSignal) {
    const target = this.list().find((t) => t.id === id);
    if (!target) throw new Error('机器人通知目标已删除或不再允许访问');
    if (!target.available) throw new Error(target.reason);
    const bot = this.store.get<BotConfig>('bot', target.botId!);
    const secret = this.store.secret('bot_' + bot.id);
    if (bot.kind === 'weixin') {
      const context = this.store.secret('bot_context_' + target.id);
      const chars = Array.from(text);
      for (let i = 0; i < chars.length; i += 2000) {
        signal.throwIfAborted();
        await this.api.request(bot.apiBaseUrl ?? weixinBaseUrl, 'sendmessage', signal, {
          token: secret,
          body: {
            msg: {
              from_user_id: '',
              to_user_id: target.recipient,
              client_id: 'tongzhou-' + randomUUID(),
              message_type: 2,
              message_state: 2,
              context_token: context,
              item_list: [{ type: 1, text_item: { text: chars.slice(i, i + 2000).join('') } }],
            },
          },
        });
      }
      return;
    }
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const token = await this.getToken(bot.appId, secret, bot.domain, timeout);
    const response = await this.fetcher(
      feishuHost(bot.domain) +
        '/open-apis/im/v1/messages?receive_id_type=' +
        (target.group ? 'chat_id' : 'open_id'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          receive_id: target.recipient,
          msg_type: 'text',
          content: JSON.stringify({ text }),
          uuid: randomUUID(),
        }),
        signal: timeout,
        redirect: 'error',
      },
    );
    if (!response.ok || (await response.json()).code !== 0)
      throw new Error('平台未确认飞书消息发送成功');
  }
}
