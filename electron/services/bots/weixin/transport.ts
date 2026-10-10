import { weixinTyping } from './typing';
import { randomUUID } from 'node:crypto';
import type { BotConfig } from '../../../../src/shared/types';
import type { BotMessage } from '../../channels/bot-transports';
import { WeixinApi, WeixinApiError, waitForWeixin, weixinBaseUrl } from './api';

export interface BotCursorStore {
  load(): string;
  save(cursor: string): void;
}
export function connectWeixin(
  config: BotConfig,
  token: string,
  receive: (message: BotMessage) => Promise<string | undefined>,
  state: (status: BotConfig['status'], error?: string) => void,
  cursorStore?: BotCursorStore,
  api = new WeixinApi(),
) {
  const controller = new AbortController(),
    { signal } = controller;
  const baseUrl = config.apiBaseUrl ?? weixinBaseUrl;
  let cursor = cursorStore?.load() ?? '';
  void (async () => {
    let failures = 0,
      timeout = 35_000;
    while (!signal.aborted) {
      try {
        const response = await api.request(baseUrl, 'getupdates', signal, {
          token,
          body: { get_updates_buf: cursor },
          timeout,
        });
        signal.throwIfAborted();
        state('connected');
        failures = 0;
        for (const message of response.msgs ?? []) {
          // ClawBot currently binds private chats; never misroute a group to a user.
          if (
            (message.message_type !== undefined && message.message_type !== 1) ||
            message.message_state === 1 ||
            message.group_id ||
            typeof message.from_user_id !== 'string' ||
            !message.from_user_id ||
            (message.to_user_id && message.to_user_id !== config.appId) ||
            typeof message.message_id !== 'string' ||
            !message.message_id ||
            typeof message.context_token !== 'string' ||
            !message.context_token ||
            !config.allowedSenders.includes(message.from_user_id)
          )
            continue;
          const text = (Array.isArray(message.item_list) ? message.item_list : [])
            .filter((item: any) => item.type === 1 && typeof item.text_item?.text === 'string')
            .map((item: any) => item.text_item.text)
            .join('\n');
          if (!text || text.length > 12_000) continue;
          signal.throwIfAborted();
          const send = async (reply: string) => {
            signal.throwIfAborted();
            const chars = Array.from(reply);
            for (let offset = 0; offset < chars.length; offset += 2000) {
              await api.request(baseUrl, 'sendmessage', signal, {
                token,
                body: {
                  msg: {
                    from_user_id: '',
                    to_user_id: message.from_user_id,
                    client_id: 'tongzhou-' + randomUUID(),
                    message_type: 2,
                    message_state: 2,
                    context_token: message.context_token,
                    item_list: [
                      { type: 1, text_item: { text: chars.slice(offset, offset + 2000).join('') } },
                    ],
                  },
                },
              });
            }
          };
          const reply = await receive({
            id: message.message_id,
            sender: message.from_user_id,
            chat: message.from_user_id,
            group: false,
            text,
            reply: send,
            replyContext: message.context_token,
            typing: weixinTyping(
              api,
              baseUrl,
              token,
              message.from_user_id,
              message.context_token,
              signal,
            ),
          });
          if (reply && !signal.aborted) await send(reply);
        }
        signal.throwIfAborted();
        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) {
          cursor = response.get_updates_buf;
          cursorStore?.save(cursor);
        }
        if (Number.isFinite(response.longpolling_timeout_ms))
          timeout = Math.max(10_000, Math.min(65_000, response.longpolling_timeout_ms + 5000));
        // Avoid busy-looping when the server returns an immediate empty batch.
        await waitForWeixin(300, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WeixinApiError && error.expired) {
          state('error', error.message);
          return;
        }
        if (error instanceof Error && error.name === 'TimeoutError') continue;
        state('error', '微信连接或回复失败，正在重试');
        await waitForWeixin(Math.min(30_000, 2000 * 2 ** Math.min(failures++, 4)), signal);
      }
    }
  })().catch(() => {
    if (!signal.aborted) state('error', '微信连接已停止，请重新连接');
  });
  return {
    close() {
      controller.abort();
    },
  };
}
