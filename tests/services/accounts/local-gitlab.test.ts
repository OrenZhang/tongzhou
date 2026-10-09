import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../../electron/services/storage/store';
import {
  gitlabInstance,
  LocalGitlabAccounts,
  readLocalGitlabCredential,
  verifyLocalGitlabIdentity,
} from '../../../electron/services/accounts/local-gitlab';
import { setServiceTransport } from '../../../electron/services/network/service-network';

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  setServiceTransport();
  vi.restoreAllMocks();
});
function fixture() {
  const store = new Store(':memory:', {
    encrypt: (v) => 'encrypted:' + v,
    decrypt: (v) => v.slice(10),
  });
  stores.push(store);
  const read = vi.fn(async () => 'fixture-gitlab-private-token');
  const identity = vi.fn(async () => ({ id: '42', login: 'local-user' }));
  const accounts = new LocalGitlabAccounts(store, { read, identity });
  return { store, accounts, read, identity };
}
describe('GitLab local accounts', () => {
  it('normalizes explicit HTTPS instances and refuses credential-bearing or non-root URLs', () => {
    expect(gitlabInstance('https://GIT.example:8443/')).toBe('https://git.example:8443');
    for (const value of [
      'http://gitlab.com',
      'https://user:private@gitlab.com',
      'https://gitlab.com?token=private',
      'https://gitlab.com/other',
      'https://gitlab.com/#private',
    ])
      expect(() => gitlabInstance(value)).toThrow();
  });
  it('queries exactly the selected host and privately reads CLI config and keyring status, rejecting masked or wrong-host credentials', async () => {
    const run = vi.fn(
      async () => 'protocol=https\nhost=git.example:8443\npassword=fixture-secret\n',
    );
    expect(await readLocalGitlabCredential('git', 'https://git.example:8443', run)).toBe(
      'fixture-secret',
    );
    expect(run.mock.calls[0]).toEqual([
      'git',
      ['-c', 'core.askPass=', '-c', 'credential.interactive=false', 'credential', 'fill'],
      'protocol=https\nhost=git.example:8443\n\n',
    ]);
    run.mockResolvedValueOnce('git.example:8443\n  ✓ Token found in keyring: fixture-cli-secret\n');
    expect(await readLocalGitlabCredential('glab', 'https://git.example:8443', run)).toBe(
      'fixture-cli-secret',
    );
    expect(run.mock.calls[1]).toEqual([
      'glab',
      ['auth', 'status', '--hostname', 'git.example:8443', '--show-token'],
      undefined,
      true,
    ]);
    run.mockResolvedValueOnce('  ✓ Token: older-cli-secret\n');
    expect(await readLocalGitlabCredential('glab', 'https://gitlab.com', run)).toBe(
      'older-cli-secret',
    );
    run.mockResolvedValueOnce('Token found in config file: ********');
    await expect(readLocalGitlabCredential('glab', 'https://gitlab.com', run)).rejects.toThrow(
      '未返回',
    );
    run.mockResolvedValueOnce('protocol=https\nhost=wrong.example\npassword=fixture-secret');
    await expect(readLocalGitlabCredential('git', 'https://gitlab.com', run)).rejects.toThrow(
      '不属于',
    );
  });
  it('returns metadata without saving, imports encrypted Git authentication and creates a disabled MCP OAuth connection', async () => {
    const f = fixture();
    const result = await f.accounts.detect('https://gitlab.com/');
    expect(result.every((r) => r.baseUrl === 'https://gitlab.com' && r.status === 'verified')).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(f.store.list('connector')).toHaveLength(0);
    const plugin = await f.accounts.use(result[0].id);
    expect(plugin).toMatchObject({
      url: 'https://gitlab.com/api/v4/mcp',
      authMode: 'headers',
      enabled: false,
    });
    expect(plugin.connectorId).toMatch(/^local-gitlab-/);
    expect(f.store.hasSecret('plugin_' + plugin.id)).toBe(false);
    const account = f.store.list<any>('connector')[0];
    expect(account).toMatchObject({
      kind: 'gitlab',
      baseUrl: 'https://gitlab.com',
      account: 'local-user',
      localSource: 'git',
    });
    expect(f.store.secret('connector_' + account.id)).toBe('fixture-gitlab-private-token');
    expect((f.store.db.prepare('SELECT value FROM secrets').get() as any).value).toBe(
      'encrypted:fixture-gitlab-private-token',
    );
    await expect(f.accounts.use(result[0].id)).rejects.toThrow('过期');
  });
  it('keeps self-managed and official identities separate and preserves token mode configuration and leaves separate MCP authorization untouched', async () => {
    const f = fixture();
    const official = await f.accounts.detect('https://gitlab.com');
    const custom = await f.accounts.detect('https://git.example:8443');
    const p1 = await f.accounts.use(official[0].id);
    const p2 = await f.accounts.use(custom[0].id);
    expect(p1.id).not.toBe(p2.id);
    expect(f.store.list('connector')).toHaveLength(2);
    f.store.put('plugin', {
      ...p2,
      enabled: true,
      catalog: [{ name: 'read_project' }],
    });
    const next = await f.accounts.detect('https://git.example:8443');
    expect(await f.accounts.use(next[0].id)).toMatchObject({
      id: p2.id,
      enabled: true,
      catalog: [{ name: 'read_project' }],
    });
    expect(f.store.list('plugin')).toHaveLength(2);
  });
  it('hides command/HTTP failures and rejects stale, expired or changed candidates', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error('private-token in stderr'));
    f.identity.mockRejectedValueOnce(new Error('private-token in response'));
    const missing = await f.accounts.detect('https://gitlab.com');
    expect(missing.map((r) => r.status)).toEqual(['unavailable', 'unverified']);
    expect(JSON.stringify(missing)).not.toContain('private');
    const stale = await f.accounts.detect('https://gitlab.com');
    await f.accounts.detect('https://gitlab.com');
    await expect(f.accounts.use(stale[0].id)).rejects.toThrow('过期');
    const expired = await f.accounts.detect('https://gitlab.com');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60000);
    await expect(f.accounts.use(expired[0].id)).rejects.toThrow('过期');
    vi.restoreAllMocks();
    const changed = await f.accounts.detect('https://gitlab.com');
    f.identity.mockResolvedValueOnce({ id: '99', login: 'another-user' });
    await expect(f.accounts.use(changed[0].id)).rejects.toThrow('变更');
    expect(f.store.list('connector')).toHaveLength(0);
  });
  it('rolls back account and secret writes if configuration storage fails', async () => {
    const f = fixture();
    const result = await f.accounts.detect('https://git.example');
    vi.spyOn(f.store, 'put').mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    await expect(f.accounts.use(result[0].id)).rejects.toThrow('write failed');
    expect(f.store.list('connector')).toHaveLength(0);
    expect(f.store.list('plugin')).toHaveLength(0);
    expect(f.store.db.prepare('SELECT * FROM secrets').all()).toHaveLength(0);
  });
  it('sends credentials only to the chosen instance with redirects blocked and never returns error response bodies', async () => {
    const transport = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 1, username: 'group.user' })),
    );
    setServiceTransport(transport as typeof fetch);
    expect(await verifyLocalGitlabIdentity('https://git.example:8443/', 'private-fixture')).toEqual(
      { id: '1', login: 'group.user' },
    );
    expect(transport.mock.calls[0][0]).toBe('https://git.example:8443/api/v4/user');
    expect(transport.mock.calls[0][1]?.redirect).toBe('error');
    transport.mockResolvedValueOnce(new Response('private-fixture', { status: 401 }));
    await expect(
      verifyLocalGitlabIdentity('https://gitlab.com', 'private-fixture'),
    ).rejects.toThrow('未验证');
    transport.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1, username: ['not-a-user'] })),
    );
    await expect(
      verifyLocalGitlabIdentity('https://gitlab.com', 'private-fixture'),
    ).rejects.toThrow('未验证');
  });
});
