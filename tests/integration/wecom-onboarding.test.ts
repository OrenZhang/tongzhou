import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WecomOnboarding } from '../../electron/services/bots/wecom-onboarding';

const services: WecomOnboarding[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  services.splice(0).forEach((service) => service.dispose());
  vi.useRealTimers();
});
const response = (data: unknown) => new Response(JSON.stringify({ data }));
const begin = {
  scode: 'private-poll-code',
  auth_url: 'https://work.weixin.qq.com/ai/qc/auth?test=1',
};
function fixture() {
  const publish = vi.fn(),
    save = vi.fn();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ status: 'init' }));
  fetcher.mockImplementation(async () => response({ status: 'init' }));
  fetcher.mockResolvedValueOnce(response(begin));
  const service = new WecomOnboarding(publish, fetcher);
  services.push(service);
  return { service, publish, fetcher, save };
}

it('uses Tongzhou as source, returns a QR image and saves credentials only after authorization', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(
    response({ status: 'success', bot_info: { botid: 'bot-1', secret: 'private-secret' } }),
  );
  const qr = await f.service.onboard('local-1', f.save);
  expect(f.fetcher.mock.calls[0][0]).toBe(
    'https://work.weixin.qq.com/ai/qc/generate?source=tongzhou',
  );
  expect(qr.image).toMatch(/^data:image\/png;base64,/);
  expect(f.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ botid: 'bot-1', secret: 'private-secret' });
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'success' }));
  expect(JSON.stringify([qr, f.publish.mock.calls])).not.toContain('private-secret');
  expect(JSON.stringify(qr)).not.toContain('private-poll-code');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it('cancels an in-flight response without saving or resurrecting authorization', async () => {
  const f = fixture();
  let resolve!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await f.service.onboard('cancel', f.save);
  await vi.advanceTimersByTimeAsync(3000);
  f.service.cancel('cancel');
  resolve(response({ status: 'success', bot_info: { botid: 'bot', secret: 'late-secret' } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenLastCalledWith({ id: 'cancel', phase: 'cancelled' });
});

it('expires after five minutes and stops polling', async () => {
  const f = fixture();
  await f.service.onboard('expired', f.save);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'expired' }));
  const calls = f.fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.fetcher).toHaveBeenCalledTimes(calls);
  expect(f.save).not.toHaveBeenCalled();
});

it('retries transient network errors and reports repeated failure without exposing provider data', async () => {
  const f = fixture();
  f.fetcher.mockRejectedValueOnce(new Error('sensitive-response'));
  f.fetcher.mockResolvedValueOnce(
    response({ status: 'success', bot_info: { botid: 'bot', secret: 'secret' } }),
  );
  await f.service.onboard('retry', f.save);
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.save).toHaveBeenCalledOnce();
  f.fetcher.mockResolvedValueOnce(response(begin));
  f.fetcher.mockRejectedValue(new Error('sensitive-response'));
  await f.service.onboard('failure', f.save);
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }));
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain('sensitive-response');
});

it.each([
  { scode: 'code', auth_url: 'https://work.weixin.qq.com.evil.test/auth' },
  { scode: 'code', auth_url: 'http://work.weixin.qq.com/auth' },
  { scode: '', auth_url: begin.auth_url },
])('rejects invalid authorization URLs or codes', async (data) => {
  const f = fixture();
  f.fetcher.mockReset().mockResolvedValueOnce(response(data));
  await expect(f.service.onboard('invalid', f.save)).rejects.toThrow('手动配置');
  expect(f.save).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenLastCalledWith({ id: 'invalid', phase: 'error' });
});

it('does not report success for malformed credentials or a failed local save', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(response({ status: 'success', bot_info: { botid: 'bot' } }));
  await f.service.onboard('incomplete', f.save);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }));
  f.fetcher.mockResolvedValueOnce(response(begin));
  f.fetcher.mockResolvedValueOnce(
    response({ status: 'success', bot_info: { botid: 'bot', secret: 'secret' } }),
  );
  f.save.mockImplementation(() => {
    throw new Error('disk failure');
  });
  await f.service.onboard('save-error', f.save);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.publish).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'save-error', phase: 'error' }),
  );
});

it('disposes pending sessions and ignores a superseded attempt with the same id', async () => {
  const f = fixture();
  let resolve!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await f.service.onboard('same-id', f.save);
  await vi.advanceTimersByTimeAsync(3000);
  f.fetcher.mockResolvedValueOnce(response(begin));
  await f.service.onboard('same-id', f.save);
  resolve(response({ status: 'success', bot_info: { botid: 'old', secret: 'old-secret' } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting' }));
  f.service.dispose();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.publish).toHaveBeenLastCalledWith({ id: 'same-id', phase: 'cancelled' });
  await expect(f.service.onboard('new', f.save)).rejects.toThrow('已关闭');
});
