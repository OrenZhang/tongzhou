import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { Connectors } from '../electron/connectors';
import { GitRepositories, repositoryUrl, type GitRunner } from '../electron/git-repositories';

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();
const url = 'https://github.com/fixture/private.git';
const token = 'fixture-only-secret';
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-git-'));
  cleanup.push(async () => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('tongzhou-git-'))
      throw new Error('Unexpected fixture path');
    await rm(root, { recursive: true, force: true });
  });
  const bare = path.join(root, 'remote.git'),
    seed = path.join(root, 'seed');
  await mkdir(seed);
  await git(root, 'init', '--bare', '-b', 'main', bare);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Fixture');
  await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  const commit = async (cwd: string, name: string) => {
    await writeFile(path.join(cwd, name + '.txt'), name);
    await git(cwd, 'add', '.');
    await git(
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      name,
    );
  };
  await commit(seed, 'initial');
  await git(seed, 'remote', 'add', 'origin', bare);
  await git(seed, 'push', 'origin', 'main');
  const store = new Store(':memory:', {
    encrypt: (v) => Buffer.from(v).toString('base64'),
    decrypt: (v) => Buffer.from(v, 'base64').toString(),
  });
  cleanup.push(() => store.close());
  const connectors = new Connectors(store, () => {});
  connectors.save({
    id: 'github',
    name: 'Fixture GitHub',
    kind: 'github',
    baseUrl: 'https://github.com',
    enabled: true,
    secret: token,
  });
  const calls: { args: string[]; authenticated: boolean }[] = [];
  // Only the transport destination is replaced. All branch/ref/worktree operations use real Git.
  const runner: GitRunner = async (cwd, args, env) => {
    const config = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env['GIT_CONFIG_KEY_' + i],
      env['GIT_CONFIG_VALUE_' + i],
    ]);
    const authenticated = config.some(
      ([k, v]) => k?.endsWith('.extraHeader') && v?.startsWith('Authorization:'),
    );
    calls.push({ args, authenticated });
    if (authenticated) {
      expect(['clone', 'fetch', 'push']).toContain(args[0]);
      expect(args).toContain(url);
      expect(config).toContainEqual(['credential.helper', '']);
      expect(config).toContainEqual(['http.followRedirects', 'false']);
      expect(args.join(' ')).not.toContain(token);
    }
    const result = (
      await exec(
        'git',
        ['-c', 'protocol.file.allow=always', ...args.map((a) => (a === url ? bare : a))],
        { cwd, env, windowsHide: true },
      )
    ).stdout;
    if (args[0] === 'clone') await git(args.at(-1)!, 'remote', 'set-url', 'origin', url);
    return result;
  };
  const service = new GitRepositories(store, path.join(root, 'data'), () => {}, runner);
  return { root, bare, seed, store, service, calls, commit };
}

describe('repository account integration', () => {
  it('clones with a saved account and separates network credentials from checkout and config', async () => {
    const f = await fixture();
    const p = await f.service.clone('github', url, path.join(f.root, '本地项目'));
    expect(await readFile(path.join(p.path, 'initial.txt'), 'utf8')).toBe('initial');
    expect(p.gitConnectorId).toBe('github');
    expect(await f.service.info(p.id)).toMatchObject({ branch: 'main', remote: url, dirty: false });
    const config = await readFile(path.join(p.path, '.git/config'), 'utf8');
    expect(config).not.toContain(token);
    expect(config).not.toContain(Buffer.from('x-access-token:' + token).toString('base64'));
    expect(f.calls.filter((c) => c.authenticated).map((c) => c.args[0])).toEqual(['clone']);
    await expect(f.service.clone('github', url, p.path)).rejects.toThrow('已存在');
    expect(await readFile(path.join(p.path, 'initial.txt'), 'utf8')).toBe('initial');
  });
  it('pulls fast-forward changes and pushes committed content without running repository hooks', async () => {
    const f = await fixture();
    const p = await f.service.clone('github', url, path.join(f.root, 'checkout'));
    await f.commit(f.seed, 'remote-change');
    await git(f.seed, 'push', 'origin', 'main');
    await f.service.sync(p.id, 'pull');
    expect(await readFile(path.join(p.path, 'remote-change.txt'), 'utf8')).toBe('remote-change');
    await f.commit(p.path, 'local-change');
    await writeFile(
      path.join(p.path, '.git/hooks/pre-push'),
      '#!/bin/sh\necho bad > hook-ran\nexit 1\n',
      { mode: 0o755 },
    );
    await f.service.sync(p.id, 'push');
    expect(await git(f.bare, 'rev-parse', 'main')).toBe(await git(p.path, 'rev-parse', 'HEAD'));
    expect(await git(p.path, 'rev-parse', 'origin/main')).toBe(
      await git(p.path, 'rev-parse', 'HEAD'),
    );
    await expect(access(path.join(p.path, 'hook-ran'))).rejects.toThrow();
    expect(f.calls.filter((c) => c.authenticated).map((c) => c.args[0])).toEqual([
      'clone',
      'fetch',
      'push',
    ]);
  });
  it('preserves dirty files and divergent commits; rejects non-fast-forward pushes', async () => {
    const f = await fixture();
    const p = await f.service.clone('github', url, path.join(f.root, 'checkout'));
    await writeFile(path.join(p.path, 'initial.txt'), 'local draft');
    await expect(f.service.sync(p.id, 'pull')).rejects.toThrow('修改');
    expect(await readFile(path.join(p.path, 'initial.txt'), 'utf8')).toBe('local draft');
    await f.commit(p.path, 'local');
    await f.commit(f.seed, 'remote');
    await git(f.seed, 'push', 'origin', 'main');
    const before = await git(p.path, 'rev-parse', 'HEAD');
    await expect(f.service.sync(p.id, 'pull')).rejects.toThrow('分叉');
    await expect(f.service.sync(p.id, 'push')).rejects.toThrow('Git 操作未完成');
    expect(await git(p.path, 'rev-parse', 'HEAD')).toBe(before);
    expect(await git(f.bare, 'rev-parse', 'main')).not.toBe(before);
  });
  it('blocks mismatched hosts, embedded credentials and multiple push destinations', async () => {
    for (const bad of [
      'https://evil.example/owner/repo',
      'https://secret@github.com/owner/repo',
      'http://github.com/owner/repo',
      'https://github.com/owner/repo?token=secret',
    ])
      expect(() => repositoryUrl(bad, 'https://github.com')).toThrow();
    const f = await fixture();
    const p = await f.service.clone('github', url, path.join(f.root, 'checkout'));
    await git(p.path, 'remote', 'set-url', '--push', 'origin', 'https://evil.example/owner/repo');
    await expect(f.service.sync(p.id, 'push')).rejects.toThrow('所选账号');
    await git(p.path, 'remote', 'set-url', '--add', '--push', 'origin', url);
    await expect(f.service.sync(p.id, 'push')).rejects.toThrow('多个地址');
    expect(f.calls.filter((c) => c.authenticated)).toHaveLength(1);
    await git(p.path, 'remote', 'set-url', 'origin', 'https://secret@github.com/owner/repo');
    expect(JSON.stringify(await f.service.info(p.id))).not.toContain('secret');
  });
});
