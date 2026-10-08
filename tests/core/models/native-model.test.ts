import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { nativeModelConnection } from '../../../electron/core/models/native-model';
import { complete } from '../../../electron/core/models/providers';
import type { Provider } from '../../../src/shared/types';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const provider = (protocol: 'minimax' | 'kimi'): Provider => ({
  id: protocol + '-account',
  name: protocol,
  protocol,
  auth: 'native',
  baseUrl: '',
  models: [],
  maxOutputTokens: 8192,
  contextChars: 0,
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-model-auth-'));
  roots.push(home);
  const put = async (file: string, value: string) => {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), value);
  };
  return { home, put };
}
describe('subscription inference adapter (official CLI retained only for auth)', () => {
  it('resolves only the matching MiniMax account and refreshes expired tokens once', async () => {
    const f = await fixture();
    await f.put('preferences/mcode-region.json', JSON.stringify({ regions: { prod: 'cn' } }));
    await f.put('config.yaml', 'provider:\n  minimax:\n    models:\n      MiniMax-M3: {}\n');
    await f.put('auth/prod/cn/mcode-public/auth-state.json', '{"status":"authenticated"}');
    const key =
      'com.minimax.mcode.oauth.prod.cn\0' +
      createHash('sha256')
        .update(path.join(f.home, 'auth') + '\0mcode-public')
        .digest('base64url');
    const token = (expiresAtMs: number) =>
      f.put(
        'auth/prod/cn/mcode-public/auth.json',
        JSON.stringify({
          records: {
            [key]: {
              accessToken: 'synthetic-token',
              audience: 'agent-backend',
              scopes: ['agent.default'],
              expiresAtMs,
            },
          },
        }),
      );
    await token(1);
    const refresh = vi.fn(() => token(Date.now() + 3600000));
    const result = await nativeModelConnection(
      provider('minimax'),
      'm:minimax:MiniMax-M3:v:',
      f.home,
      refresh,
    );
    expect(result).toMatchObject({
      model: 'MiniMax-M3',
      secret: 'synthetic-token',
      provider: {
        protocol: 'anthropic',
        auth: 'bearer',
        baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(
      nativeModelConnection(provider('minimax'), 'm:minimax:MiniMax-M3:v:unknown', f.home, refresh),
    ).rejects.toThrow('模型尚未支持');
  });
  it.each([
    [undefined, 'openai-chat'],
    ['anthropic', 'anthropic'],
    ['openai_responses', 'openai-responses'],
  ])('maps Kimi model aliases with protocol %s to %s', async (protocol, expected) => {
    const f = await fixture();
    await f.put(
      'config.toml',
      `[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.com/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\nkey="oauth/kimi-code"\n[models."kimi-code/fixture"]\nprovider="managed:kimi-code"\nmodel="fixture"\n${protocol === undefined ? '' : `protocol="${protocol}"\n`}`,
    );
    await f.put(
      'credentials/kimi-code.json',
      JSON.stringify({
        access_token: 'synthetic-kimi-token',
        expires_at: Date.now() / 1000 + 3600,
      }),
    );
    const refresh = vi.fn();
    const result = await nativeModelConnection(
      provider('kimi'),
      'kimi-code/fixture',
      f.home,
      refresh,
    );
    expect(result.model).toBe('fixture');
    expect(result.provider.protocol).toBe(expected);
    expect(refresh).not.toHaveBeenCalled();
    if (protocol === undefined) {
      const transport = vi.fn(async (url, init) => {
        expect(String(url)).toBe('https://api.kimi.com/coding/v1/chat/completions');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-kimi-token');
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'fixture' });
        return new Response(
          'data: {"choices":[{"delta":{"content":"正常"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      });
      const completion = await complete({
        ...result,
        transport,
        instructions: 'test',
        messages: [{ id: 'm', sessionId: 's', role: 'user', content: '你好', createdAt: 1 }],
        tools: [],
        signal: new AbortController().signal,
        onDelta() {},
      });
      expect(completion.text).toBe('正常');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects an unknown explicit Kimi protocol without guessing or refreshing credentials', async () => {
    const f = await fixture();
    await f.put(
      'config.toml',
      '[providers.p]\ntype="kimi"\nbase_url="https://api.kimi.com/coding/v1"\n[providers.p.oauth]\nstorage="file"\nkey="oauth/kimi-code"\n[models.m]\nprovider="p"\nmodel="m"\nprotocol="unknown-wire"\n',
    );
    await f.put(
      'credentials/kimi-code.json',
      JSON.stringify({ access_token: 'synthetic-token', expires_at: Date.now() / 1000 + 3600 }),
    );
    const refresh = vi.fn();
    await expect(nativeModelConnection(provider('kimi'), 'm', f.home, refresh)).rejects.toThrow(
      '更新同舟',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
  it('does not forward subscription credentials to an arbitrary configured endpoint', async () => {
    const f = await fixture();
    await f.put(
      'config.toml',
      '[providers.p]\ntype="kimi"\nbase_url="https://example.com/coding/v1"\n[providers.p.oauth]\nstorage="file"\nkey="oauth/kimi-code"\n[models.m]\nprovider="p"\nmodel="m"\nprotocol="anthropic"\n',
    );
    await expect(nativeModelConnection(provider('kimi'), 'm', f.home)).rejects.toThrow(
      '官方模型接口',
    );
  });
  it('does not reveal malformed credential contents in parser errors', async () => {
    const f = await fixture();
    await f.put('preferences/mcode-region.json', 'secret-fixture-invalid-json');
    await expect(nativeModelConnection(provider('minimax'), 'm', f.home)).rejects.toThrow(
      '订阅模型凭据读取或刷新失败',
    );
  });
});
