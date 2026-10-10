import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DingtalkOnboarding } from '../../electron/services/bots/dingtalk-onboarding';
const services: DingtalkOnboarding[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  services.splice(0).forEach((s) => s.dispose());
  vi.useRealTimers();
});
const response = (data: object) => new Response(JSON.stringify({ errcode: 0, ...data }));
const begin = {
  device_code: 'private-device',
  verification_uri_complete: 'https://open-dev.dingtalk.com/authorize?code=fixture',
  expires_in: 30,
  interval: 1,
};
const success = { status: 'SUCCESS', client_id: 'ding-fixture', client_secret: 'private-secret' };
function fixture() {
  const publish = vi.fn(),
    save = vi.fn();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response({ status: 'WAITING' }));
  fetcher
    .mockResolvedValueOnce(response({ nonce: 'private-nonce' }))
    .mockResolvedValueOnce(response(begin));
  const service = new DingtalkOnboarding(publish, fetcher);
  services.push(service);
  return { service, publish, save, fetcher };
}
it('uses the official three-step protocol and keeps credentials and poll tokens out of renderer results', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(response(success));
  const qr = await f.service.onboard('bot', f.save);
  expect(f.fetcher.mock.calls[0][0]).toBe('https://oapi.dingtalk.com/app/registration/init');
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual({ source: 'DING_DWS_CLAW' });
  expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body))).toEqual({ nonce: 'private-nonce' });
  expect(qr.image).toMatch(/^data:image\/png;base64,/);
  expect(f.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(JSON.parse(String(f.fetcher.mock.calls[2][1]?.body))).toEqual({
    device_code: 'private-device',
  });
  expect(f.save).toHaveBeenCalledExactlyOnceWith({
    client_id: 'ding-fixture',
    client_secret: 'private-secret',
  });
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'success' }));
  expect(JSON.stringify([qr, f.publish.mock.calls])).not.toMatch(
    /private-secret|private-device|private-nonce/,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
});
it.each(['EXPIRED', 'FAIL', 'UNKNOWN'])(
  'ends a terminal %s result without saving',
  async (status) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(response({ status }));
    await f.service.onboard('terminal', f.save);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: status === 'EXPIRED' ? 'expired' : 'error' }),
    );
    expect(f.save).not.toHaveBeenCalled();
  },
);
it('expires locally and recovers from a transient network failure', async () => {
  const f = fixture();
  await f.service.onboard('expire', f.save);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'expired' }));
  f.fetcher
    .mockResolvedValueOnce(response({ nonce: 'retry' }))
    .mockResolvedValueOnce(response(begin))
    .mockRejectedValueOnce(new Error('private-error'))
    .mockResolvedValueOnce(response(success));
  await f.service.onboard('retry', f.save);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.save).toHaveBeenCalledOnce();
});
it('ignores late success after cancellation or a replacement attempt', async () => {
  const f = fixture();
  let resolve!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await f.service.onboard('same', f.save);
  await vi.advanceTimersByTimeAsync(1000);
  f.service.cancel('same');
  f.fetcher
    .mockResolvedValueOnce(response({ nonce: 'new' }))
    .mockResolvedValueOnce(response(begin));
  await f.service.onboard('same', f.save);
  resolve(response(success));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting' }));
  f.service.dispose();
  await expect(f.service.onboard('new', f.save)).rejects.toThrow('已关闭');
});
it.each([
  'https://dingtalk.com.evil.test/qr',
  'http://open-dev.dingtalk.com/qr',
  'https://user@open-dev.dingtalk.com/qr',
])('rejects invalid authorization URL %s', async (url) => {
  const f = fixture();
  f.fetcher
    .mockReset()
    .mockResolvedValueOnce(response({ nonce: 'n' }))
    .mockResolvedValueOnce(response({ ...begin, verification_uri_complete: url }));
  await expect(f.service.onboard('invalid', f.save)).rejects.toThrow('手动配置');
  expect(f.save).not.toHaveBeenCalled();
});
it('does not report success after a failed local save or missing credentials', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(response(success));
  f.save.mockImplementation(() => {
    throw Error('private-disk');
  });
  await f.service.onboard('save', f.save);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }));
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain('private-disk');
  const g = fixture();
  g.fetcher.mockResolvedValueOnce(response({ status: 'SUCCESS', client_id: 'id' }));
  await g.service.onboard('missing', g.save);
  await vi.advanceTimersByTimeAsync(1000);
  expect(g.save).not.toHaveBeenCalled();
});
