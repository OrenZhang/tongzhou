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
  const invalidateIdle = vi.fn();
  const networks = new NetworkProfiles(
    store,
    root,
    () => {},
    guard,
    invalidate,
    undefined,
    invalidateIdle,
  );
  cleanup.push(async () => {
    await networks.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { networks, store, root, guard, invalidate, invalidateIdle };
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

async function healthFixture() {
  const f = await fixture();
  await f.networks.save({
    id: 'one',
    name: 'Test',
    source: 'config',
    config: JSON.stringify({ proxies: [node, { ...node, name: 'fast' }] }),
  });
  const internal = f.networks as any;
  internal.running.set('one', {
    ready: true,
    proxy: 12345,
    controller: 12346,
    secret: 'private-controller',
  });
  vi.spyOn(f.networks, 'start').mockResolvedValue(undefined);
  vi.spyOn(internal, 'stopCore').mockImplementation(async () => internal.running.delete('one'));
  const control = vi.spyOn(internal, 'request').mockResolvedValue({});
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(JSON.stringify({ delay: url.includes('/fast/') ? 10 : 50 })),
  );
  vi.stubGlobal('fetch', fetcher);
  return { ...f, internal, control, fetcher };
}
describe('node scans and automatic routing', () => {
  it('automatic preflight invalidates idle chat connections without stopping its own auth client', async () => {
    const f = await healthFixture();
    await f.networks.check('one');
    const saved = f.store.get<any>('networkProfile', 'one');
    f.store.put('networkProfile', { ...saved, routing: 'auto' });
    f.invalidate.mockClear();
    await f.networks.resolve({ mode: 'managed', profileId: 'one' });
    expect(f.networks.list().profiles[0].selected).toBe('fast');
    expect(f.invalidateIdle).toHaveBeenCalledWith('one');
    expect(f.invalidate).not.toHaveBeenCalled();
  });
  it('checks both nodes without moving live traffic, caches results, then chooses a usable fast route', async () => {
    const f = await healthFixture();
    await f.networks.check('one');
    expect(f.control).not.toHaveBeenCalled();
    const p = f.networks.list().profiles[0];
    expect(p.selected).toBe('fixture');
    expect(p.health?.recommended).toBe('fast');
    expect(p.health?.results).toHaveLength(2);
    expect(p.checking).toBeUndefined();
    await f.networks.setRouting('one', 'auto');
    expect(f.networks.list().profiles[0]).toMatchObject({ selected: 'fast', routing: 'auto' });
    f.fetcher.mockClear();
    expect(await f.networks.resolve({ mode: 'managed', profileId: 'one' }, 'own-turn')).toEqual({
      mode: 'proxy',
      proxyUrl: 'http://127.0.0.1:12345',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.networks.select('one', 'fixture');
    expect(f.networks.list().profiles[0].routing).toBe('manual');
  });
  it('cancels scans and does not enable auto mode using partial results', async () => {
    const f = await healthFixture();
    f.fetcher.mockImplementation(
      async (_url, init?: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const checking = f.networks.setRouting('one', 'auto');
    const rejected = expect(checking).rejects.toThrow('没有通过');
    await expect.poll(() => f.fetcher.mock.calls.length).toBeGreaterThan(0);
    f.networks.cancelCheck('one');
    await rejected;
    expect(f.networks.list().profiles[0]).toMatchObject({ routing: 'manual', selected: 'fixture' });
    expect(f.networks.list().profiles[0].checking).toBeUndefined();
    expect(f.control).not.toHaveBeenCalled();
  });
  it('preserves a working active node when another turn owns it, and rejects switching an unusable active route', async () => {
    const f = await healthFixture();
    await f.networks.check('one');
    const saved = f.store.get<any>('networkProfile', 'one');
    f.store.put('networkProfile', { ...saved, routing: 'auto' });
    f.guard.mockImplementation(() => {
      throw new Error('another active turn');
    });
    await f.networks.resolve({ mode: 'managed', profileId: 'one' }, 'own-turn');
    expect(f.guard).toHaveBeenCalledWith('one', 'own-turn');
    expect(f.control).not.toHaveBeenCalled();
    f.internal.health.get('one').results.find((n: any) => n.node === 'fixture').chatgpt.status =
      'timeout';
    await expect(
      f.networks.resolve({ mode: 'managed', profileId: 'one' }, 'own-turn'),
    ).rejects.toThrow('还有任务运行');
    expect(f.control).not.toHaveBeenCalled();
  });
  it('never picks general connectivity alone when the ChatGPT target is blocked', async () => {
    const f = await healthFixture();
    f.fetcher.mockImplementation(async (url) =>
      new URL(url).searchParams.get('url')?.includes('chatgpt.com')
        ? new Response(JSON.stringify({ message: 'status 403 secret-token' }), { status: 504 })
        : new Response(JSON.stringify({ delay: 10 })),
    );
    await expect(f.networks.setRouting('one', 'auto')).rejects.toThrow('没有通过');
    expect(f.networks.list().profiles[0].health?.recommended).toBeUndefined();
    expect(JSON.stringify(f.networks.list())).not.toContain('secret-token');
  });
});
