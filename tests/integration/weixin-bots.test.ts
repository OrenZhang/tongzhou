import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WeixinApi, WeixinApiError, weixinApiUrl } from '../../electron/services/bots/weixin/api';
import { WeixinOnboarding } from '../../electron/services/bots/weixin/onboarding';
import { connectWeixin } from '../../electron/services/bots/weixin/transport';
import { Bots } from '../../electron/services/channels/bots';
import { Store } from '../../electron/services/storage/store';
import type { BotConfig, Run } from '../../src/shared/types';
const cleanup: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const base = 'https://ilinkai.weixin.qq.com';
const begin = { qrcode: 'private-qr', qrcode_img_content: 'https://weixin.qq.com/test-qr' };
const login = {
  status: 'confirmed',
  bot_token: 'private-token',
  ilink_bot_id: 'bot-id',
  ilink_user_id: 'owner',
  baseurl: base,
};
function authFixture() {
  const request = vi.fn<WeixinApi['request']>().mockResolvedValue({ status: 'wait' });
  request.mockResolvedValueOnce(begin);
  const publish = vi.fn(),
    save = vi.fn();
  const auth = new WeixinOnboarding(publish, { request } as unknown as WeixinApi);
  cleanup.push(() => auth.dispose());
  return { auth, publish, save, request };
}
it('uses official wire headers, Tongzhou attribution and lossless uint64 ids', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{"ret":0,"msgs":[{"message_id":18446744073709551615}]}'));
  const api = new WeixinApi();
  const result = await api.request(base, 'getupdates', new AbortController().signal, {
    token: 'private-token',
    body: { get_updates_buf: '' },
  });
  expect(result.msgs[0].message_id).toBe('18446744073709551615');
  const init = fetcher.mock.calls[0][1]!;
  const headers = new Headers(init.headers);
  expect(headers.get('User-Agent')).toMatch(/^Tongzhou\//);
  expect(headers.get('Authorization')).toBe('Bearer private-token');
  expect(headers.get('iLink-App-Id')).toBe('bot');
  expect(headers.get('AuthorizationType')).toBe('ilink_bot_token');
  expect(JSON.parse(String(init.body)).base_info.bot_agent).toMatch(/^Tongzhou\//);
  fetcher.mockResolvedValue(new Response('{"status":"wait"}'));
  await api.request(base, 'get_qrcode_status?qrcode=x', new AbortController().signal);
  const pollHeaders = new Headers(fetcher.mock.calls[1][1]!.headers);
  expect(pollHeaders.has('Authorization')).toBe(false);
  expect(pollHeaders.has('X-WECHAT-UIN')).toBe(false);
});
it.each([
  'https://evil.test',
  'https://weixin.qq.com.evil.test',
  'http://ilinkai.weixin.qq.com',
  'https://user:pass@ilinkai.weixin.qq.com',
  'https://ilinkai.weixin.qq.com:444',
  'https://ilinkai.weixin.qq.com/path',
])('rejects untrusted API routing: %s', (value) => {
  expect(() => weixinApiUrl(value)).toThrow();
});
it('supports verification retries and official region redirects without publishing credentials', async () => {
  const f = authFixture();
  f.request.mockResolvedValueOnce({
    status: 'scaned_but_redirect',
    redirect_host: 'ilinkai2.weixin.qq.com',
  });
  f.request.mockResolvedValueOnce({ status: 'need_verifycode' });
  f.request.mockResolvedValueOnce({ status: 'need_verifycode' });
  f.request.mockResolvedValueOnce(login);
  const qr = await f.auth.onboard('login', f.save);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'verify_required' }));
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.request).toHaveBeenCalledTimes(3);
  f.auth.verify('login', '1234');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'verify_invalid' }));
  f.auth.verify('login', '5678');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.request.mock.calls.at(-1)![0]).toBe('https://ilinkai2.weixin.qq.com');
  expect(f.request.mock.calls.at(-1)![1]).toContain('verify_code=5678');
  expect(f.save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ bot_token: 'private-token', ilink_user_id: 'owner' }),
  );
  expect(JSON.stringify([qr, f.publish.mock.calls])).not.toContain('private-token');
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain('5678');
});
it.each(['expired', 'verify_code_blocked', 'binded_redirect'])(
  'ends login on %s without saving',
  async (status) => {
    const f = authFixture();
    f.request.mockResolvedValueOnce({ status });
    await f.auth.onboard('terminal', f.save);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(2);
  },
);
it('ignores late confirmation after cancellation and rejects hostile redirects', async () => {
  const f = authFixture();
  let resolve!: (value: unknown) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await f.auth.onboard('cancel', f.save);
  await vi.advanceTimersByTimeAsync(1000);
  f.auth.cancel('cancel');
  resolve(login);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.save).not.toHaveBeenCalled();
  f.request
    .mockResolvedValueOnce(begin)
    .mockResolvedValueOnce({ status: 'scaned_but_redirect', redirect_host: 'evil.test' });
  await f.auth.onboard('hostile', f.save);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }));
  expect(f.request.mock.calls.every((call) => !call[0].includes('evil'))).toBe(true);
});
const config: BotConfig = {
  id: 'weixin',
  name: '微信',
  kind: 'weixin',
  appId: 'bot-id',
  allowedSenders: ['owner'],
  allowedChats: [],
};
const incoming = {
  message_id: '9007199254740993',
  from_user_id: 'owner',
  to_user_id: 'bot-id',
  message_type: 1,
  message_state: 0,
  context_token: 'context-private',
  item_list: [{ type: 1, text_item: { text: '/status' } }],
};
it('receives private messages, preserves reply context, persists cursor and stops cleanly', async () => {
  const request = vi.fn<WeixinApi['request']>().mockResolvedValue({ ret: 0 });
  request.mockResolvedValueOnce({
    msgs: [
      incoming,
      { ...incoming, from_user_id: 'outsider' },
      { ...incoming, group_id: 'group' },
      { ...incoming, message_type: 2 },
    ],
    get_updates_buf: 'next',
  });
  const receive = vi.fn(async () => '答复'),
    state = vi.fn();
  const cursor = { load: () => 'previous', save: vi.fn() };
  const connection = connectWeixin(config, 'token', receive, state, cursor, {
    request,
  } as unknown as WeixinApi);
  cleanup.push(() => connection.close());
  await vi.advanceTimersByTimeAsync(0);
  expect(receive).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][3]?.body).toEqual({ get_updates_buf: 'previous' });
  expect(request.mock.calls[1][3]?.body).toMatchObject({
    msg: {
      context_token: 'context-private',
      to_user_id: 'owner',
      item_list: [{ text_item: { text: '答复' } }],
    },
  });
  expect(cursor.save).toHaveBeenCalledExactlyOnceWith('next');
  connection.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(request).toHaveBeenCalledTimes(2);
});
it('stops on expired tokens rather than repeatedly using invalid credentials', async () => {
  const request = vi.fn<WeixinApi['request']>().mockRejectedValue(new WeixinApiError(true));
  const state = vi.fn();
  const connection = connectWeixin(config, 'token', vi.fn(), state, undefined, {
    request,
  } as unknown as WeixinApi);
  cleanup.push(() => connection.close());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledOnce();
  expect(state).toHaveBeenLastCalledWith('error', expect.stringContaining('重新扫码'));
});
it('routes natural text through existing task core and returns only that run result', async () => {
  const store = new Store(':memory:', {
    encrypt: (v) => Buffer.from(v).toString('base64'),
    decrypt: (v) => Buffer.from(v, 'base64').toString(),
  });
  cleanup.push(() => store.close());
  store.put('provider', {
    id: 'fixture-provider',
    name: 'Fixture',
    models: ['fixture-model'],
  });
  const runtime: any = {
    changed: vi.fn(),
    start: vi.fn(() => 'run-1'),
    isActive: () => false,
    enqueue: vi.fn(),
    cancel: vi.fn(),
    snapshot: () => ({ approvals: [] }),
  };
  const bots = new Bots(store, runtime, (() => ({ close() {} })) as any);
  cleanup.push(() => bots.dispose());
  bots.save({ ...config, secret: 'token' });
  const reply = vi.fn(async () => {});
  const message = {
    id: 'message-1',
    sender: 'owner',
    chat: 'owner',
    group: false,
    text: '帮我整理这段内容',
    reply,
  };
  expect(await bots.receive(config.id, message)).toBeUndefined();
  expect(runtime.start).toHaveBeenCalledOnce();
  expect(runtime.enqueue).not.toHaveBeenCalled();
  await bots.receive(config.id, message);
  expect(runtime.start).toHaveBeenCalledOnce();
  const input = runtime.start.mock.calls[0][0];
  const session = store.get<import('../../src/shared/types').Session>('session', input.sessionId);
  expect(session.botConversation?.sender).toBe('owner');
  store.message({
    id: 'answer',
    sessionId: session.id,
    role: 'assistant',
    content: '处理结果',
    createdAt: Date.now(),
    runId: 'run-1',
    status: 'complete',
  });
  const run = { id: 'run-1', sessionId: session.id, botContext: input.botContext } as Run;
  await bots.notify({ ...run, id: 'other-run' }, 'completed');
  expect(reply).not.toHaveBeenCalled();
  await bots.notify(run, 'approval');
  expect(reply).toHaveBeenLastCalledWith(expect.stringContaining('回到同舟'));
  await bots.notify(run, 'completed');
  expect(reply).toHaveBeenLastCalledWith('处理结果');
  await bots.notify(run, 'completed');
  expect(reply).toHaveBeenCalledTimes(2);
  await bots.receive(config.id, { ...message, id: 'message-2' });
  bots.remove(config.id);
  await bots.notify(run, 'completed');
  expect(reply).toHaveBeenCalledTimes(2);
});
