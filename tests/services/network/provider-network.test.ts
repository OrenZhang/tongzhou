import { describe, expect, it } from 'vitest';
import {
  accountEnvironment,
  accountProxyConfig,
} from '../../../electron/services/network/provider-network';
import { normalizeProxyUrl, networkKey } from '../../../src/shared/provider-network';
import { providerSchema } from '../../../electron/services/storage/validation';
describe('account-only network configuration', () => {
  it('overrides only a copied environment and always bypasses loopback callbacks', () => {
    const original = {
      HTTP_PROXY: 'http://system:80',
      https_proxy: 'http://old:81',
      NO_PROXY: '*',
      PATH: 'tools',
    };
    const own = accountEnvironment(original, { mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890/' });
    expect(own.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(own.https_proxy).toBe(own.HTTPS_PROXY);
    expect(own.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(original).toEqual({
      HTTP_PROXY: 'http://system:80',
      https_proxy: 'http://old:81',
      NO_PROXY: '*',
      PATH: 'tools',
    });
    expect(accountEnvironment(original, { mode: 'inherit' })).toEqual(original);
    expect(accountEnvironment(original, { mode: 'direct' })).toEqual({
      PATH: 'tools',
      NO_PROXY: '*',
      no_proxy: '*',
    });
  });
  it('rejects credentials, non-proxy protocols and path/query injection', () => {
    for (const url of [
      'http://user:pass@localhost:7890',
      'socks5://localhost:7890',
      'file:///tmp',
      'http://localhost/path',
      'http://localhost?x=1',
      'http://localhost#x',
      '',
    ])
      expect(() => normalizeProxyUrl(url)).toThrow();
    expect(normalizeProxyUrl(' https://proxy.example:8443/ ')).toBe('https://proxy.example:8443');
    expect(accountProxyConfig({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' })).toMatchObject({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:7890',
    });
    expect(accountProxyConfig({ mode: 'direct' })).toEqual({ mode: 'direct' });
    expect(networkKey()).toBe(networkKey({ mode: 'inherit' }));
  });
  it('validates persisted configuration and scopes it to ChatGPT', () => {
    const p = {
      id: 'fixture',
      name: 'fixture',
      protocol: 'codex',
      auth: 'chatgpt',
      baseUrl: '',
      models: [],
      maxOutputTokens: 8192,
      contextChars: 0,
    };
    expect(
      providerSchema.parse({ ...p, network: { mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890/' } })
        .network?.proxyUrl,
    ).toBe('http://127.0.0.1:7890');
    expect(() => providerSchema.parse({ ...p, network: { mode: 'proxy' } })).toThrow();
    expect(
      providerSchema.parse({ ...p, network: { mode: 'direct', proxyUrl: 'old-value' } }).network,
    ).toEqual({ mode: 'direct' });
    expect(() =>
      providerSchema.parse({ ...p, protocol: 'kimi', auth: 'native', network: { mode: 'direct' } }),
    ).toThrow();
  });
});
