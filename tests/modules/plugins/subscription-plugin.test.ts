import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../../../electron/services/storage/store';
import { engineHome } from '../../../electron/services/accounts/account-paths';
import {
  SubscriptionPluginConnection,
  subscriptionPluginAccount,
  subscriptionPluginCredential,
} from '../../../electron/modules/plugins/subscription-plugin';
import { callMiniMaxPlan, minimaxPlanTools } from '../../../electron/modules/plugins/minimax-plan';
import { pluginSecret } from '../../../electron/modules/plugins/code-hosting';
import { setServiceTransport } from '../../../electron/services/network/service-network';
import type { Provider, PluginConfig } from '../../../src/shared/types';

const roots: string[] = [];
const stores: Store[] = [];
const signal = new AbortController().signal;
const provider = (protocol: 'kimi' | 'minimax'): Provider => ({
  id: `${protocol}-account`,
  name: protocol,
  protocol,
  auth: 'native',
  baseUrl: '',
  enabled: true,
  models: [],
  maxOutputTokens: 8192,
  contextChars: 0,
});
const plugin = (id = 'tongzhou-kimi-web'): PluginConfig => ({
  id,
  name: id,
  accountProviderId: id === 'tongzhou-kimi-web' ? 'kimi-account' : 'minimax-account',
  transport: 'stdio',
  command: 'must-not-launch',
  args: [],
  url: '',
  enabled: true,
  readOnlyTools: [],
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-plugin-plan-'));
  roots.push(root);
  const put = async (file: string, text: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  return { root, put };
}
const kimiConfig = (extra = '') =>
  `[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.com/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\nkey="oauth/kimi-code"\n${extra}`;
afterEach(async () => {
  setServiceTransport();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('subscription plugin authentication', () => {
  it('refreshes expired Kimi credentials without needing any model alias or copying a key', async () => {
    const f = await fixture();
    await f.put('config.toml', kimiConfig());
    await f.put('credentials/kimi-code.json', '{"access_token":"old","expires_at":1}');
    const refresh = vi.fn(() =>
      f.put(
        'credentials/kimi-code.json',
        JSON.stringify({ access_token: 'renewed', expires_at: Date.now() / 1000 + 3600 }),
      ),
    );
    expect(
      await subscriptionPluginCredential(provider('kimi'), f.root, 'fetch', refresh),
    ).toMatchObject({ secret: 'renewed', endpoint: 'https://api.kimi.com/coding/v1' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it.each([
    'https://evil.example/search',
    'https://api.kimi.com.evil.example/coding/v1/search',
    'https://api.kimi.com/coding/v1/fetch',
  ])('rejects mismatched service endpoint %s before refresh', async (endpoint) => {
    const f = await fixture();
    await f.put('config.toml', kimiConfig(`[services.moonshot_search]\nbase_url="${endpoint}"`));
    await f.put('credentials/kimi-code.json', '{"access_token":"secret","expires_at":1}');
    const refresh = vi.fn();
    await expect(
      subscriptionPluginCredential(provider('kimi'), f.root, 'search', refresh),
    ).rejects.toThrow('不匹配');
    expect(refresh).not.toHaveBeenCalled();
  });
  it('resolves the selected MiniMax region and requires the agent-backend audience', async () => {
    const f = await fixture();
    await f.put('preferences/mcode-region.json', '{"regions":{"prod":"en"}}');
    await f.put('auth/prod/en/mcode-public/auth-state.json', '{"status":"authenticated"}');
    const key =
      'com.minimax.mcode.oauth.prod.en\0' +
      createHash('sha256')
        .update(path.join(f.root, 'auth') + '\0mcode-public')
        .digest('base64url');
    const save = (audience: string) =>
      f.put(
        'auth/prod/en/mcode-public/auth.json',
        JSON.stringify({
          records: {
            [key]: {
              accessToken: 'plan-token',
              audience,
              scopes: ['agent.default'],
              expiresAtMs: Date.now() + 3600000,
            },
          },
        }),
      );
    await save('agent-backend');
    expect(await subscriptionPluginCredential(provider('minimax'), f.root)).toMatchObject({
      secret: 'plan-token',
      endpoint: 'https://agent.minimax.io',
    });
    await save('other-service');
    await expect(subscriptionPluginCredential(provider('minimax'), f.root)).rejects.toThrow(
      '不可用',
    );
  });
  it('does not leak malformed credential text or return an expired token after refresh', async () => {
    const f = await fixture();
    await f.put('config.toml', kimiConfig());
    await f.put('credentials/kimi-code.json', 'very-private-token');
    await expect(subscriptionPluginCredential(provider('kimi'), f.root)).rejects.toThrow(
      '套餐凭据读取或刷新失败',
    );
    await f.put('credentials/kimi-code.json', '{"access_token":"expired-secret","expires_at":1}');
    await expect(
      subscriptionPluginCredential(provider('kimi'), f.root, 'search', async () => {}),
    ).rejects.toThrow('已过期');
  });
  it('reuses current credentials for each call, keeps old manual keys unused, and fails after logout or disable', async () => {
    const f = await fixture();
    const store = new Store(path.join(f.root, 'tongzhou.db'), {
      encrypt: (v) => v,
      decrypt: (v) => v,
    });
    stores.push(store);
    store.put('provider', provider('kimi'));
    const config = plugin();
    store.put('plugin', config);
    store.saveSecret('plugin_' + config.id, '{"KIMI_API_KEY":"old-manual-key"}');
    expect(pluginSecret(store, config)).toBe('');
    const home = engineHome(f.root, 'kimi', 'kimi-account');
    const relative = path.relative(f.root, home);
    await f.put(path.join(relative, 'config.toml'), kimiConfig());
    const saveToken = (token: string) =>
      f.put(
        path.join(relative, 'credentials/kimi-code.json'),
        JSON.stringify({ access_token: token, expires_at: Date.now() / 1000 + 3600 }),
      );
    await saveToken('one');
    const connection = new SubscriptionPluginConnection(store, config);
    const fetcher = vi.fn<typeof fetch>(async () => new Response('# Article'));
    setServiceTransport(fetcher);
    await connection.connect(signal);
    expect(fetcher).not.toHaveBeenCalled();
    await connection.call('fetch_page', { url: 'https://example.com' }, signal);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer one');
    await saveToken('two');
    await connection.call('fetch_page', { url: 'https://example.com' }, signal);
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer two');
    await rm(path.join(home, 'credentials/kimi-code.json'));
    await expect(
      connection.call('fetch_page', { url: 'https://example.com' }, signal),
    ).rejects.toThrow('套餐凭据');
    store.put('provider', { ...provider('kimi'), enabled: false });
    await expect(connection.connect(signal)).rejects.toThrow('停用');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.secret('plugin_' + config.id)).toContain('old-manual-key');
  });
  it('rejects cross-vendor and arbitrary plugin account bindings', () => {
    const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
    stores.push(store);
    store.put('provider', provider('kimi'));
    expect(() =>
      subscriptionPluginAccount(store, {
        ...plugin('minimax-coding'),
        accountProviderId: 'kimi-account',
      }),
    ).toThrow('不匹配');
    expect(() => subscriptionPluginAccount(store, { ...plugin(), id: 'custom-mcp' })).toThrow(
      '不匹配',
    );
  });
});

describe('MiniMax plan gateway', () => {
  it.each([
    ['minimax-coding', 'web_search', { query: 'test' }, 'web_search', { query: 'test' }],
    [
      'minimax-coding',
      'understand_image',
      { image_url: 'https://example.com/cat.png', prompt: 'describe' },
      'images_understand',
      { image_info: [{ url: 'https://example.com/cat.png', prompt: 'describe' }] },
    ],
    [
      'minimax-multimedia',
      'text_to_image',
      { prompt: 'cat' },
      'image_synthesize',
      { requests: [{ prompt: 'cat', output_file: 'slot_0.png' }] },
    ],
    [
      'minimax-multimedia',
      'text_to_audio',
      { text: 'hello' },
      'synthesize_speech',
      { text: 'hello' },
    ],
    [
      'minimax-multimedia',
      'generate_video',
      { model: 'MiniMax-H3', prompt: 'cat', duration: 5, resolution: '768P' },
      'submit_video_generation',
      { model: 'MiniMax-H3', prompt: 'cat', duration: 5, resolution: '768P', ratio: '16:9' },
    ],
    [
      'minimax-multimedia',
      'generate_video',
      {
        model: 'MiniMax-Hailuo-2.3',
        prompt: 'cat',
        duration: 6,
        resolution: '1080P',
        input_image_url: 'https://example.com/cat.png',
      },
      'submit_video_generation',
      {
        model: 'MiniMax-Hailuo-2.3',
        prompt: 'cat',
        duration: 6,
        resolution: '1080P',
        input_image: { url: 'https://example.com/cat.png' },
        reference_type: 'first_frame',
      },
    ],
  ])('maps %s / %s to the official plan route', async (id, name, args, route, body) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"code":0,"result":"ok"}'));
    await callMiniMaxPlan(
      id,
      name,
      args,
      'https://agent.minimax.cn',
      'plan-token',
      signal,
      fetcher,
    );
    expect(fetcher.mock.calls[0][0]).toBe(`https://agent.minimax.cn/mavis/api/v1/mcp/${route}`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer plan-token' },
      redirect: 'error',
    });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body);
  });
  it('limits the catalog per plugin and blocks generation through the search plugin', async () => {
    expect(minimaxPlanTools('minimax-coding').map((t) => t.name)).toEqual([
      'web_search',
      'understand_image',
    ]);
    expect(
      minimaxPlanTools('minimax-multimedia').find((t) => t.name === 'text_to_image')?.annotations
        ?.readOnlyHint,
    ).toBe(false);
    const fetcher = vi.fn();
    await expect(
      callMiniMaxPlan(
        'minimax-coding',
        'text_to_image',
        { prompt: 'cat' },
        'https://agent.minimax.cn',
        'token',
        signal,
        fetcher,
      ),
    ).rejects.toThrow('不支持');
    await expect(
      callMiniMaxPlan(
        'minimax-coding',
        'web_search',
        { query: 'test' },
        'https://api.minimax.io',
        'token',
        signal,
        fetcher,
      ),
    ).rejects.toThrow('官方账号接口');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects incompatible video settings before spending quota', async () => {
    const fetcher = vi.fn();
    for (const args of [
      { model: 'MiniMax-H3', prompt: 'cat', duration: 5, resolution: '768P', ratio: 'adaptive' },
      {
        model: 'MiniMax-Hailuo-2.3',
        prompt: 'cat',
        duration: 10,
        resolution: '1080P',
        input_image_url: 'https://example.com/cat.png',
      },
    ]) {
      await expect(
        callMiniMaxPlan(
          'minimax-multimedia',
          'generate_video',
          args,
          'https://agent.minimax.cn',
          'token',
          signal,
          fetcher,
        ),
      ).rejects.toThrow('视频模型');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('redacts service failures, handles quota errors, and does not retry generation', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('private-token', { status: 403 }));
    await expect(
      callMiniMaxPlan(
        'minimax-multimedia',
        'text_to_image',
        { prompt: 'cat' },
        'https://agent.minimax.cn',
        'token',
        signal,
        fetcher,
      ),
    ).rejects.toThrow('HTTP 403');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(
      new Response('{"base_resp":{"status_code":1008,"status_msg":"secret"}}'),
    );
    await expect(
      callMiniMaxPlan(
        'minimax-coding',
        'web_search',
        { query: 'test' },
        'https://agent.minimax.cn',
        'token',
        signal,
        fetcher,
      ),
    ).rejects.toThrow('套餐拒绝');
  });
});
