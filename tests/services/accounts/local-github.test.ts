import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../../electron/services/storage/store';
import {
  LocalGithubAccounts,
  readLocalGithubCredential,
  verifyLocalGithubIdentity,
} from '../../../electron/services/accounts/local-github';
import { setServiceTransport } from '../../../electron/services/network/service-network';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  setServiceTransport();
  vi.restoreAllMocks();
});
function fixture() {
  const store = new Store(':memory:', {
    encrypt: (value) => `encrypted:${value}`,
    decrypt: (value) => value.slice(10),
  });
  stores.push(store);
  const read = vi.fn(async (source: string) => `fixture-${source}-secret`);
  const identity = vi.fn(async (token: string) => ({
    id: token.includes('gh-') ? '2' : '1',
    login: token.includes('gh-') ? 'cli-user' : 'git-user',
  }));
  const catalog = vi.fn(async () => [
    { name: 'get_me', description: 'Account', inputSchema: { type: 'object' } },
  ]);
  const accounts = new LocalGithubAccounts(store, { read, identity, catalog });
  return { store, read, identity, catalog, accounts };
}

describe('local GitHub accounts', () => {
  it('reads Git on stdin and CLI credentials without putting secrets on argv; rejects wrong hosts and malformed tokens', async () => {
    const run = vi.fn(
      async () => 'protocol=https\nhost=github.com\nusername=123\npassword=fixture-token=extra\n',
    );
    expect(await readLocalGithubCredential('git', run)).toBe('fixture-token=extra');
    expect(run.mock.calls[0]).toEqual([
      'git',
      ['-c', 'core.askPass=', '-c', 'credential.interactive=false', 'credential', 'fill'],
      'protocol=https\nhost=github.com\n\n',
    ]);
    run.mockResolvedValueOnce('fixture-cli-token\n');
    expect(await readLocalGithubCredential('gh', run)).toBe('fixture-cli-token');
    expect(run.mock.calls[1]).toEqual(['gh', ['auth', 'token', '--hostname', 'github.com']]);
    run.mockResolvedValueOnce('protocol=https\nhost=evil.example\npassword=fixture-secret');
    await expect(readLocalGithubCredential('git', run)).rejects.toThrow('官方站点');
    run.mockResolvedValueOnce('token\nmalicious-header');
    await expect(readLocalGithubCredential('gh', run)).rejects.toThrow('未检测到');
  });
  it('returns identity metadata only, persists nothing on discovery, then checks MCP and saves encrypted credentials on explicit enable', async () => {
    const f = fixture();
    const result = await f.accounts.detect();
    expect(result.map((a) => a.account)).toEqual(['git-user', 'cli-user']);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.store.list('connector')).toEqual([]);
    expect(f.store.list('plugin')).toEqual([]);
    expect(f.catalog).not.toHaveBeenCalled();
    const id = await f.accounts.enable(result[0].id);
    const plugin = f.store.get<any>('plugin', id);
    expect(plugin).toMatchObject({
      enabled: true,
      connectorId: 'local-github-git-1',
      catalog: [{ name: 'get_me' }],
    });
    expect(f.store.secret('connector_' + plugin.connectorId)).toBe('fixture-git-secret');
    const raw = f.store.db.prepare('SELECT value FROM secrets').get() as { value: string };
    expect(raw.value).toBe('encrypted:fixture-git-secret');
    expect(JSON.stringify(f.store.list('connector')) + JSON.stringify(plugin)).not.toContain(
      'secret',
    );
    expect(f.identity).toHaveBeenCalledTimes(3);
    await expect(f.accounts.enable(result[0].id)).rejects.toThrow('过期');
    const next = await f.accounts.detect();
    expect(await f.accounts.enable(next[0].id)).toBe(id);
    expect(f.store.list('plugin')).toHaveLength(1);
  });
  it('distinguishes missing and unverifiable login without leaking command or HTTP errors', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error('private-command-output'));
    f.identity.mockRejectedValueOnce(new Error('private-response-body'));
    const result = await f.accounts.detect();
    expect(result.map((a) => a.status)).toEqual(['unavailable', 'unverified']);
    expect(JSON.stringify(result)).not.toContain('private');
    for (const a of result) await expect(f.accounts.enable(a.id)).rejects.toThrow('过期');
  });
  it('keeps detection candidates on failed MCP checks, rejects expired or rescanned candidates and rolls back storage failures', async () => {
    const f = fixture();
    const detected = await f.accounts.detect();
    f.catalog.mockRejectedValueOnce(new Error('MCP unavailable'));
    await expect(f.accounts.enable(detected[0].id)).rejects.toThrow('MCP unavailable');
    expect(f.store.list('connector')).toHaveLength(0);
    expect(f.store.list('plugin')).toHaveLength(0);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60000);
    await expect(f.accounts.enable(detected[0].id)).rejects.toThrow('过期');
    vi.restoreAllMocks();
    const current = await f.accounts.detect();
    await f.accounts.detect();
    await expect(f.accounts.enable(current[0].id)).rejects.toThrow('过期');
    const valid = await f.accounts.detect();
    const put = vi.spyOn(f.store, 'put');
    put.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    await expect(f.accounts.enable(valid[0].id)).rejects.toThrow('storage unavailable');
    expect(f.store.list('connector')).toHaveLength(0);
    expect(f.store.list('plugin')).toHaveLength(0);
    expect(f.store.db.prepare('SELECT * FROM secrets').all()).toHaveLength(0);
  });
  it('rejects a concurrent rescan while a plugin connection is being checked', async () => {
    const f = fixture();
    const detected = await f.accounts.detect();
    let release!: () => void;
    f.catalog.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return [];
    });
    const enabling = f.accounts.enable(detected[0].id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.accounts.detect();
    release();
    await expect(enabling).rejects.toThrow('过期');
    expect(f.store.list('connector')).toHaveLength(0);
  });
  it('checks only the official GitHub identity endpoint with redirects blocked and suppresses response bodies', async () => {
    const transport = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 8, login: 'fixture-user' })),
    );
    setServiceTransport(transport as typeof fetch);
    expect(await verifyLocalGithubIdentity('fixture-private-token')).toEqual({
      id: '8',
      login: 'fixture-user',
    });
    expect(transport.mock.calls[0][0]).toBe('https://api.github.com/user');
    expect(transport.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
    });
    expect(new Headers(transport.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer fixture-private-token',
    );
    transport.mockResolvedValueOnce(
      new Response('private failure with fixture-private-token', { status: 401 }),
    );
    await expect(verifyLocalGithubIdentity('fixture-private-token')).rejects.toThrow(
      '本地登录未验证',
    );
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ id: 8, login: ['fake-login'] })));
    await expect(verifyLocalGithubIdentity('fixture-private-token')).rejects.toThrow(
      '本地登录未验证',
    );
  });
});
