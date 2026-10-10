import { afterEach, expect, it, vi } from 'vitest';
import { Feishu } from '../../electron/services/channels/feishu';
import { Store } from '../../electron/services/storage/store';

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value: unknown, options: { signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), ms);
      options.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('cancelled'));
        },
        { once: true },
      );
    }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('passes the authorized sender to the bot callback without persisting a second inbound channel', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  const changed = vi.fn(),
    authorized = vi.fn();
  const service = new Feishu(store, { changed });
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ supported_auth_methods: ['client_secret'] })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          verification_uri_complete: 'https://accounts.feishu.cn/authorize?code=test',
          device_code: 'private-device',
          expire_in: 30,
          interval: 5,
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          client_id: 'app-id',
          client_secret: 'private-secret',
          user_info: { open_id: 'owner' },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, tenant_access_token: 'private-token' })),
    );
  try {
    const qr = await service.onboard('bot', '飞书', authorized);
    expect(qr.image).toMatch(/^data:image\/png;base64,/);
    await vi.advanceTimersByTimeAsync(5000);
    expect(authorized).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'bot', appId: 'app-id', receiveId: 'owner' }),
      'private-secret',
      ['owner'],
    );
    expect(authorized.mock.calls[0][0]).not.toHaveProperty('inbound');
    expect(authorized.mock.calls[0][0]).not.toHaveProperty('sessionId');
    expect(store.list('channel')).toEqual([]);
    expect(JSON.stringify([qr, store.list('channelAuth')])).not.toMatch(
      /private-secret|private-token|private-device/,
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally {
    service.dispose();
    store.close();
  }
});
