import { describe, it, expect } from 'vitest';
import { bestNetworkNode, probeNetworkNode, probeFailure } from '../electron/network-health';
describe('node health', () => {
  it('retries a different public target and ranks only nodes reaching both OpenAI services', async () => {
    const a = await probeNetworkNode('a', async (_, url) =>
      url.includes('gstatic') ? { status: 'timeout' } : { status: 'ok', ms: 50 },
    );
    expect(a.internet.target).toBe('cp.cloudflare.com');
    const b = await probeNetworkNode('b', async () => ({ status: 'ok', ms: 10 }));
    const blocked = { ...b, node: 'blocked', chatgpt: { status: 'blocked' as const } };
    expect(bestNetworkNode([a, b, blocked])).toBe('b');
    expect(bestNetworkNode([blocked])).toBeUndefined();
  });
  it('classifies failures without leaking request URLs or credentials', () => {
    expect(probeFailure('lookup private-token failed')).toBe('dns');
    expect(probeFailure('x509 secret-password')).toBe('tls');
    expect(probeFailure('context deadline exceeded')).toBe('timeout');
    expect(probeFailure('status 403, token=secret')).toBe('blocked');
    expect(probeFailure('secret-password')).toBe('failed');
  });
});
