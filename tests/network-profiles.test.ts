import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { NetworkProfiles } from '../electron/network-profiles';
import { parseNetworkConfig, runtimeNetworkConfig } from '../electron/network-config';
import { boundedBody, NetworkCore } from '../electron/network-core';
import { accountEnvironment, accountProxyConfig } from '../electron/provider-network';
import { providerSchema } from '../electron/validation';
import { networkKey } from '../src/shared/provider-network';
const node = {
  name: 'fixture',
  type: 'http',
  server: '127.0.0.1',
  port: 7890,
  password: 'private-node-password',
};
const config = JSON.stringify({ proxies: [node] });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fn of cleanup.splice(0)) await fn();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-network-'));
  const store = new Store(':memory:', {
    encrypt: (s) => Buffer.from(s).toString('base64'),
    decrypt: (s) => Buffer.from(s, 'base64').toString(),
  });
  const guard = vi.fn();
  const invalidate = vi.fn();
  const networks = new NetworkProfiles(store, root, () => {}, guard, invalidate);
  cleanup.push(async () => {
    await networks.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { networks, store, root, guard, invalidate };
}
describe('managed account networks', () => {
  it('extracts nodes and discards source routing, TUN, scripts and remote providers', () => {
    const nodes = parseNetworkConfig(
      JSON.stringify({
        proxies: [node],
        tun: { enable: true },
        script: 'unsafe',
        'mixed-port': 7890,
        'external-controller': '0.0.0.0:9090',
        'proxy-providers': { remote: { url: 'https://invalid' } },
      }),
    );
    const runtime = parse(runtimeNetworkConfig(nodes, 'fixture', 20001, 20002, 'secret'));
    expect(runtime.tun.enable).toBe(false);
    expect(runtime['allow-lan']).toBe(false);
    expect(runtime['bind-address']).toBe('127.0.0.1');
    expect(runtime['external-controller']).toBe('127.0.0.1:20002');
    expect(runtime.rules).toEqual(['MATCH,TZ-OUT']);
    expect(runtime.script).toBeUndefined();
    expect(runtime['proxy-providers']).toBeUndefined();
    expect(runtime['proxy-groups'][0].proxies).not.toContain('DIRECT');
  });
  it('rejects file-reading nodes, duplicate names, invalid syntax and unsupported sources', () => {
    for (const invalid of [
      'not-yaml',
      'proxies: [',
      'a: &a { b: *a }\nproxies: [*a]',
      JSON.stringify({ 'proxy-providers': {} }),
      JSON.stringify({ proxies: [node, node] }),
      JSON.stringify({ proxies: [{ ...node, certificate: '/private' }] }),
      JSON.stringify({ proxies: [{ ...node, name: 'DIRECT' }] }),
      JSON.stringify({ proxies: [{ ...node, port: -1 }] }),
      JSON.stringify({ proxies: [{ ...node, type: 'direct' }] }),
      JSON.stringify({ proxies: [{ ...node, type: 'trojan', password: '' }] }),
    ])
      expect(() => parseNetworkConfig(invalid)).toThrow();
  });
  it('validates managed profile references and fails closed if a caller forgets resolution', () => {
    expect(networkKey({ mode: 'managed', profileId: 'one' })).not.toBe(
      networkKey({ mode: 'managed', profileId: 'two' }),
    );
    expect(() => accountEnvironment({}, { mode: 'managed', profileId: 'one' })).toThrow();
    expect(() => accountProxyConfig({ mode: 'managed', profileId: 'one' })).toThrow();
    expect(() =>
      providerSchema.parse({
        id: 'x',
        name: 'x',
        protocol: 'codex',
        auth: 'chatgpt',
        baseUrl: '',
        models: [],
        maxOutputTokens: 8192,
        contextChars: 0,
        network: { mode: 'managed' },
      }),
    ).toThrow();
  });
  it('stores secrets separately and exposes only safe profile metadata', async () => {
    const f = await fixture();
    await f.networks.save({ id: 'one', name: 'Test', source: 'config', config });
    expect(JSON.stringify(f.networks.list())).not.toContain(node.password);
    expect(JSON.stringify(f.store.list('networkProfile'))).not.toContain(node.password);
    expect(f.store.secret('network_one')).toContain(node.password);
    expect(f.networks.list().profiles[0].selected).toBe('fixture');
    await f.networks.save({ id: 'one', name: 'Renamed', source: 'config' });
    expect(f.networks.list().profiles[0].name).toBe('Renamed');
    expect(f.store.secret('network_one')).toContain(node.password);
  });
  it('preserves original profile on failed validation and refuses active edits', async () => {
    const f = await fixture();
    await f.networks.save({ id: 'one', name: 'Test', source: 'config', config });
    await expect(
      f.networks.save({ id: 'one', name: 'Bad', source: 'config', config: 'bad' }),
    ).rejects.toThrow();
    expect(f.networks.list().profiles[0].name).toBe('Test');
    f.guard.mockImplementation(() => {
      throw new Error('active');
    });
    await expect(f.networks.select('one', 'fixture')).rejects.toThrow('active');
    await expect(f.networks.stop('one')).rejects.toThrow('active');
    await expect(f.networks.remove('one')).rejects.toThrow('active');
  });
  it('protects bound profiles from deletion and erases credentials when unbound', async () => {
    const f = await fixture();
    await f.networks.save({ id: 'one', name: 'Test', source: 'config', config });
    const p = f.store.providers()[0];
    f.store.saveProvider({ ...p, network: { mode: 'managed', profileId: 'one' } });
    await expect(f.networks.remove('one')).rejects.toThrow('取消使用');
    f.store.saveProvider({ ...p, network: { mode: 'direct' } });
    await f.networks.remove('one');
    expect(f.store.hasSecret('network_one')).toBe(false);
  });
  it('keeps subscriptions encrypted, refreshes atomically, and sanitizes fetch failures', async () => {
    const f = await fixture();
    const fetcher = vi.fn(async () => new Response(config));
    vi.stubGlobal('fetch', fetcher);
    await f.networks.save({
      id: 'one',
      name: 'Test',
      source: 'subscription',
      subscriptionUrl: 'https://example.invalid/sub?token=private-subscription',
    });
    expect(JSON.stringify(f.networks.list())).not.toContain('private-subscription');
    fetcher.mockImplementation(async () => {
      throw new Error('private-subscription');
    });
    await expect(f.networks.refresh('one')).rejects.toThrow('未覆盖原配置');
    expect(f.networks.list().profiles[0].nodes).toEqual(['fixture']);
    expect(f.store.secret('network_one')).toContain('private-subscription');
    await expect(
      f.networks.save({
        id: 'bad',
        name: 'bad',
        source: 'subscription',
        subscriptionUrl: 'http://example.invalid',
      }),
    ).rejects.toThrow('HTTPS');
  });
  it('bounds downloads, rejects tampered core archives and reports missing cores without fallback', async () => {
    await expect(boundedBody(new Response('12345'), 4)).rejects.toThrow('超过');
    const f = await fixture();
    await expect(new NetworkCore(f.root).install(Buffer.from('tampered'))).rejects.toThrow();
    await f.networks.save({ id: 'one', name: 'Test', source: 'config', config });
    await expect(f.networks.resolve({ mode: 'managed', profileId: 'one' })).rejects.toThrow(
      '安装内核',
    );
    expect(await f.networks.resolve({ mode: 'direct' })).toEqual({ mode: 'direct' });
  });
});
