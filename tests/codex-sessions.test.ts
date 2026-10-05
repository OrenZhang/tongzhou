import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { CodexSessions } from '../electron/codex-sessions';
import { codexTransportArgs } from '../electron/codex-transport';
import { userAgent } from '../electron/request-identity';
import { networkKey } from '../src/shared/provider-network';
const client = () => Object.assign(new EventEmitter(), { stop: vi.fn(), reject: vi.fn() }) as any;
afterEach(() => vi.useRealTimers());
describe('idle Codex connections', () => {
  it('expires and bounds connections, rejects idle tools, and detaches listeners on reuse', () => {
    vi.useFakeTimers();
    const pool = new CodexSessions(1000, 1),
      a = client(),
      b = client();
    pool.put('one', 'key', 'account', 'thread', a);
    a.emit('request', { id: 1 });
    expect(a.reject).toHaveBeenCalledWith(1, 'No active Tongzhou turn');
    expect(pool.take('one', 'key', 'thread')).toBe(a);
    expect(a.listenerCount('request')).toBe(0);
    expect(a.listenerCount('failure')).toBe(0);
    pool.put('one', 'key', 'account', 'thread', a);
    pool.put('two', 'key', 'account', 'thread2', b);
    expect(a.stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(pool.take('two', 'key', 'thread2')).toBeUndefined();
  });
  it('discards failed, changed or invalidated connections without affecting other accounts', () => {
    const pool = new CodexSessions(),
      a = client(),
      b = client(),
      c = client();
    pool.put('one', 'key', 'account', 'thread', a);
    expect(pool.take('one', 'different-network', 'thread')).toBeUndefined();
    expect(a.stop).toHaveBeenCalledOnce();
    pool.put('two', 'key', 'account', 'thread', b);
    b.emit('failure', new Error('closed'));
    expect(pool.take('two', 'key', 'thread')).toBeUndefined();
    pool.put('three', 'key', 'other-account', 'thread', c);
    pool.clear('account');
    expect(c.stop).not.toHaveBeenCalled();
    pool.clear();
    expect(c.stop).toHaveBeenCalledOnce();
  });
  it('defaults to WebSocket with bounded retries and retains explicit HTTPS mode', () => {
    expect(codexTransportArgs().join(' ')).toContain('supports_websockets=true');
    expect(codexTransportArgs().join(' ')).toContain('websocket_connect_timeout_ms=4000');
    expect(codexTransportArgs().join(' ')).toContain('stream_max_retries=1');
    expect(codexTransportArgs('http').join(' ')).toContain('supports_websockets=false');
    for (const mode of ['http', 'auto'] as const)
      expect(codexTransportArgs(mode).join(' ')).toContain(
        `http_headers={"User-Agent"="${userAgent}"}`,
      );
    expect(networkKey()).toBe(networkKey({ mode: 'inherit', transport: 'auto' }));
    expect(networkKey()).not.toBe(networkKey({ mode: 'inherit', transport: 'http' }));
  });
});
