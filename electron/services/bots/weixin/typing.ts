import { WeixinApi } from './api';

/** Serialize start/stop, so a slow ticket request cannot turn typing back on after completion. */
export function weixinTyping(
  api: Pick<WeixinApi, 'request'>,
  baseUrl: string,
  token: string,
  user: string,
  context: string,
  signal: AbortSignal,
) {
  let ticket = '';
  let wanted = false;
  let shown = false;
  let queue = Promise.resolve();
  return (active: boolean) => {
    wanted = active;
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (signal.aborted || (active && !wanted)) return;
        if (!ticket && active) {
          const config = await api.request(baseUrl, 'getconfig', signal, {
            token,
            timeout: 2500,
            body: { ilink_user_id: user, context_token: context },
          });
          if (config.ret === 0 && typeof config.typing_ticket === 'string')
            ticket = config.typing_ticket;
        }
        if (!ticket || (active && !wanted) || (!active && !shown)) return;
        shown = active;
        await api.request(baseUrl, 'sendtyping', signal, {
          token,
          timeout: 2500,
          body: { ilink_user_id: user, typing_ticket: ticket, status: active ? 1 : 2 },
        });
      });
    return queue;
  };
}
