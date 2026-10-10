import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../electron/services/storage/store';
import { BotNotifications } from '../../electron/services/bots/notifications';
import { Channels } from '../../electron/services/channels/channels';
import { WeixinApi } from '../../electron/services/bots/weixin/api';
import { weixinTyping } from '../../electron/services/bots/weixin/typing';
import type { BotConfig, Run } from '../../src/shared/types';
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
function fixture() {
  const store = new Store(':memory:', {
    encrypt: (v) => Buffer.from(v).toString('base64'),
    decrypt: (v) => Buffer.from(v, 'base64').toString(),
  });
  cleanup.push(() => store.close());
  const bot: BotConfig = {
    id: 'bot',
    name: '微信',
    kind: 'weixin',
    appId: 'app',
    allowedSenders: ['owner'],
    allowedChats: [],
  };
  store.put('bot', bot);
  store.saveSecret('bot_bot', 'secret');
  const request = vi.fn<WeixinApi['request']>().mockResolvedValue({ ret: 0 });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ code: 0 })));
  const token = vi.fn(async () => 'tenant');
  const adapter = new BotNotifications(store, { request }, fetcher, token);
  const channels = new Channels(store, () => {});
  channels.attachTargets(adapter);
  cleanup.push(() => channels.dispose());
  return { store, bot, adapter, channels, request, fetcher, token };
}
it('requires prior Weixin context, persists it encrypted and checks recipient revocation', async () => {
  const f = fixture();
  const id = f.adapter.list()[0].id;
  expect(f.adapter.list()[0].available).toBe(false);
  await expect(f.channels.send(id, '提醒')).rejects.toThrow('先从微信');
  f.adapter.remember(f.bot, 'outsider', 'not-allowed');
  expect(f.adapter.list()[0].available).toBe(false);
  f.adapter.remember(f.bot, 'owner', 'private-context');
  expect(JSON.stringify(f.adapter.list())).not.toContain('private-context');
  expect(
    JSON.stringify(
      f.store.db.prepare('SELECT value FROM secrets WHERE id=?').get('bot_context_' + id),
    ),
  ).not.toContain('private-context');
  const sent = await f.channels.send(id, '完成了', undefined, 'same');
  await f.channels.send(id, '完成了', undefined, 'same');
  expect(sent.status).toBe('sent');
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.request.mock.calls[0][3]?.body).toMatchObject({
    msg: { to_user_id: 'owner', context_token: 'private-context' },
  });
  f.store.put('bot', { ...f.bot, allowedSenders: [] });
  await expect(f.adapter.send(id, '不能发', new AbortController().signal)).rejects.toThrow(
    '不再允许',
  );
});
it('sends one completion notification for the selected run and never on another run', async () => {
  const f = fixture();
  f.adapter.remember(f.bot, 'owner', 'context');
  const session = f.store.createSession();
  const run = {
    id: 'run',
    sessionId: session.id,
    status: 'running',
    startedAt: Date.now(),
    model: 'm',
  } as Run;
  f.store.put('run', run);
  f.channels.saveRule({
    id: 'notice',
    channelId: f.adapter.list()[0].id,
    sessionId: session.id,
    targetRunId: run.id,
    enabled: true,
    once: true,
    events: ['completed'],
    template: '{title} 已完成',
  });
  await f.channels.notify({ ...run, id: 'another' }, 'completed');
  expect(f.request).not.toHaveBeenCalled();
  await Promise.all([f.channels.notify(run, 'completed'), f.channels.notify(run, 'completed')]);
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.store.get<any>('notificationRule', 'notice').enabled).toBe(false);
});
it('reuses Feishu credentials to deliver a scheduled task result once without another AI send', async () => {
  const f = fixture();
  f.store.put('bot', { ...f.bot, kind: 'feishu' });
  const id = f.adapter.list()[0].id;
  const session = f.store.createSession();
  f.store.put('session', { ...session, automationJob: 'job' });
  const rule = { id: 'daily', kind: 'task', enabled: true, notificationTargetId: id };
  f.store.put('automation', rule);
  f.store.put('automationJob', { id: 'job', rule, sessionId: session.id, runId: 'run' });
  f.store.message({
    id: 'answer',
    sessionId: session.id,
    runId: 'run',
    role: 'assistant',
    status: 'complete',
    content: '今日提醒',
    createdAt: 1,
  });
  const run = { id: 'run', sessionId: session.id } as Run;
  await Promise.all([f.channels.notify(run, 'completed'), f.channels.notify(run, 'completed')]);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.token).toHaveBeenCalledOnce();
  expect(String(f.fetcher.mock.calls[0][0])).toContain('receive_id_type=open_id');
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toMatchObject({
    receive_id: 'owner',
    content: JSON.stringify({ text: '今日提醒' }),
  });
  expect(f.store.list<any>('delivery')[0].status).toBe('sent');
});
it('records uncertain sends without pretending success or retrying automatically', async () => {
  const f = fixture();
  f.adapter.remember(f.bot, 'owner', 'context');
  f.request.mockRejectedValue(new Error('private-token upstream error'));
  const result = await f.channels.send(f.adapter.list()[0].id, '提醒', undefined, 'failure');
  expect(result.status).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain('private-token');
  await f.channels.send(f.adapter.list()[0].id, '提醒', undefined, 'failure');
  expect(f.request).toHaveBeenCalledOnce();
});
it('records unavailable completion destinations instead of silently dropping the reminder', async () => {
  const f = fixture();
  f.adapter.remember(f.bot, 'owner', 'context');
  const session = f.store.createSession();
  const run = {
    id: 'run',
    sessionId: session.id,
    status: 'running',
    startedAt: Date.now(),
    model: 'm',
  } as Run;
  f.store.put('run', run);
  f.channels.saveRule({
    id: 'notice',
    channelId: f.adapter.list()[0].id,
    sessionId: session.id,
    targetRunId: run.id,
    enabled: true,
    once: true,
    events: ['completed'],
    template: '已完成',
  });
  f.adapter.clear(f.bot);
  await f.channels.notify(run, 'completed');
  await f.channels.notify(run, 'completed');
  expect(f.request).not.toHaveBeenCalled();
  expect(f.store.list<any>('delivery')).toHaveLength(1);
  expect(f.store.list<any>('delivery')[0]).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('先从微信'),
  });
});
it('serializes typing start and stop while the ticket request is delayed', async () => {
  let resolve!: (v: any) => void;
  const request = vi
    .fn<WeixinApi['request']>()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({ ret: 0 });
  const typing = weixinTyping(
    { request },
    'https://ilinkai.weixin.qq.com',
    'token',
    'user',
    'context',
    new AbortController().signal,
  );
  const start = typing(true);
  await Promise.resolve();
  await Promise.resolve();
  const stop = typing(false);
  resolve({ ret: 0, typing_ticket: 'ticket' });
  await Promise.all([start, stop]);
  expect(
    request.mock.calls.filter((c) => c[1] === 'sendtyping').map((c) => c[3]?.body?.status),
  ).toEqual([]);
});

it('sends typing status for a pending request and clears it afterward', async () => {
  const request = vi
    .fn<WeixinApi['request']>()
    .mockResolvedValueOnce({ ret: 0, typing_ticket: 'ticket' })
    .mockResolvedValue({ ret: 0 });
  const typing = weixinTyping(
    { request },
    'https://ilinkai.weixin.qq.com',
    'token',
    'user',
    'context',
    new AbortController().signal,
  );
  await typing(true);
  await typing(false);
  expect(
    request.mock.calls.filter((c) => c[1] === 'sendtyping').map((c) => c[3]?.body?.status),
  ).toEqual([1, 2]);
});
