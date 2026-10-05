import { appFetch } from './request-identity';
import {
  WSClient as FeishuClient,
  EventDispatcher,
  Domain,
  LoggerLevel,
} from '@larksuiteoapi/node-sdk';
import { WSClient as WecomClient, generateReqId } from '@wecom/aibot-node-sdk';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { feishuHost, feishuToken } from './feishu';
import type { BotConfig } from '../src/shared/types';
export interface BotMessage {
  id: string;
  sender: string;
  chat: string;
  group: boolean;
  text: string;
}
export function connectBot(
  b: BotConfig,
  secret: string,
  receive: (m: BotMessage) => Promise<string | undefined>,
  state: (status: BotConfig['status'], error?: string) => void,
) {
  const controller = new AbortController();
  const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
  const failed = () => {
    if (!controller.signal.aborted) state('error', '机器人连接或回复失败，请检查凭据、权限与网络');
  };
  if (b.kind === 'feishu') {
    const client = new FeishuClient({
      appId: b.appId,
      appSecret: secret,
      domain: b.domain === 'lark' ? Domain.Lark : Domain.Feishu,
      loggerLevel: LoggerLevel.error,
      logger: { error: failed, warn() {}, info() {}, debug() {}, trace() {} },
    });
    void client
      .start({
        eventDispatcher: new EventDispatcher({}).register({
          'im.message.receive_v1': async (event: any) => {
            if (
              controller.signal.aborted ||
              event.sender?.sender_type !== 'user' ||
              event.message?.message_type !== 'text'
            )
              return;
            try {
              const m = event.message;
              const text = await receive({
                id: m.message_id,
                sender: event.sender.sender_id?.open_id,
                chat: m.chat_id,
                group: m.chat_type !== 'p2p',
                text: JSON.parse(m.content).text,
              });
              if (!text || controller.signal.aborted) return;
              const token = await feishuToken(b.appId, secret, b.domain, signal());
              const r = await appFetch(
                feishuHost(b.domain) +
                  `/open-apis/im/v1/messages/${encodeURIComponent(m.message_id)}/reply`,
                {
                  method: 'POST',
                  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) }),
                  redirect: 'error',
                  signal: signal(),
                },
              );
              if (!r.ok || ((await r.json()) as any).code !== 0) failed();
            } catch {
              failed();
            }
          },
        }),
      })
      .then(() => {
        if (!controller.signal.aborted) state('listening');
      })
      .catch(failed);
    return {
      close() {
        controller.abort();
        client.close({ force: true });
      },
    };
  }
  if (b.kind === 'wecom') {
    const client = new WecomClient({
      botId: b.appId,
      secret,
      maxAuthFailureAttempts: 3,
      maxReconnectAttempts: 10,
      logger: { error: failed, warn() {}, info() {}, debug() {} },
    });
    client.on('authenticated', () => state('connected'));
    client.on('disconnected', () => {
      if (!controller.signal.aborted) state('connecting');
    });
    client.on('error', failed);
    client.on('message.text', async (frame) => {
      if (controller.signal.aborted || !frame.body || frame.body.aibotid !== b.appId) return;
      try {
        const m = frame.body;
        const text = await receive({
          id: m.msgid,
          sender: m.from.userid,
          chat: m.chatid || m.from.userid,
          group: m.chattype === 'group',
          text: m.text.content,
        });
        if (text && !controller.signal.aborted)
          await client.replyStream(frame, generateReqId('tongzhou'), text, true);
      } catch {
        failed();
      }
    });
    client.connect();
    return {
      close() {
        controller.abort();
        client.disconnect();
      },
    };
  }
  const client = new DWClient({
    clientId: b.appId,
    clientSecret: secret,
    keepAlive: true,
    debug: false,
  });
  let lastConnected = false;
  const timer = setInterval(() => {
    if (!controller.signal.aborted && client.connected !== lastConnected) {
      lastConnected = client.connected;
      state(client.connected ? 'connected' : 'connecting');
    }
  }, 5000);
  timer.unref();
  client.registerCallbackListener(TOPIC_ROBOT, (res) => {
    void (async () => {
      try {
        if (controller.signal.aborted) return;
        const m = JSON.parse(res.data);
        if (
          m.msgtype !== 'text' ||
          !m.senderStaffId ||
          (m.isInAtList === false && m.conversationType === '2')
        )
          return;
        const text = await receive({
          id: m.msgId || res.headers.messageId,
          sender: m.senderStaffId,
          chat: m.conversationId,
          group: m.conversationType !== '1',
          text: m.text?.content,
        });
        if (!text || controller.signal.aborted) return;
        const url = new URL(m.sessionWebhook);
        if (
          url.protocol !== 'https:' ||
          url.hostname !== 'oapi.dingtalk.com' ||
          url.port ||
          url.username ||
          url.password ||
          url.pathname !== '/robot/sendBySession'
        )
          throw new Error('Invalid reply destination');
        const r = await appFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
          redirect: 'error',
          signal: signal(),
        });
        if (!r.ok || ((await r.json()) as any).errcode !== 0) failed();
      } catch {
        failed();
      } finally {
        if (!controller.signal.aborted)
          client.socketCallBackResponse(res.headers.messageId, { status: 'SUCCESS' });
      }
    })();
  });
  void client
    .connect()
    .then(() => {
      if (!controller.signal.aborted && !client.connected) failed();
    })
    .catch(failed);
  return {
    close() {
      controller.abort();
      clearInterval(timer);
      client.disconnect();
    },
  };
}
