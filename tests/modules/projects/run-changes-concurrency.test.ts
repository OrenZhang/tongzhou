import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../../electron/services/storage/store';
import { ChangeCheckpoints } from '../../../electron/modules/projects/run-changes';
import type { RunChanges } from '../../../src/shared/task';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cosail-checkpoint-lock-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  cleanup.push(() => store.close());
  const changes = new ChangeCheckpoints(store, root);
  const project = async (id: string) => {
    const directory = path.join(root, id);
    mkdirSync(directory);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      writeFileSync(path.join(directory, name), 'before');
    git('add', '.');
    git('commit', '-m', 'initial');
    const record = store.put('project', { id, name: id, path: directory, createdAt: 1 });
    const session = store.createSession(id);
    await changes.begin(id + '-run', session.id, record);
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      writeFileSync(path.join(directory, name), 'after');
    const run = await changes.finish(id + '-run');
    return { ...record, git, run };
  };
  return { root, store, changes, project };
}
function pauseCommit(changes: ChangeCheckpoints) {
  const read = deferred(),
    release = deferred(),
    original = changes.staged.bind(changes);
  vi.spyOn(changes, 'staged').mockImplementationOnce(async (id) => {
    const result = await original(id);
    read.resolve();
    await release.promise;
    return result;
  });
  return { read: read.promise, release: release.resolve };
}

describe('project checkpoint mutation serialization', () => {
  it('keeps concurrent stage and restore outside the reviewed commit, including aliased project paths', async () => {
    const f = fixture(),
      project = await f.project('project');
    await f.changes.stage(project.run.id, 'a.txt');
    const reviewed = await f.changes.staged(project.id);
    expect(reviewed.patch).not.toContain('b.txt');
    const alias = path.join(f.root, 'alias');
    symlinkSync(project.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
    f.store.put('project', { ...project, id: 'alias', path: alias });
    const aliasRun = f.store.put('runChanges', {
      ...project.run,
      id: 'alias-run',
      projectId: 'alias',
    } satisfies RunChanges);
    const otherInstance = new ChangeCheckpoints(f.store, f.root);
    const pause = pauseCommit(f.changes);
    const commit = f.changes.commit(project.id, 'reviewed-a', reviewed.hash);
    await pause.read;
    const stage = otherInstance.stage(aliasRun.id, 'b.txt');
    const restore = otherInstance.restore(aliasRun.id, 'c.txt');
    try {
      expect(
        await Promise.race([
          Promise.race([stage, restore]).then(() => 'mutated'),
          delay(100).then(() => 'waiting'),
        ]),
      ).toBe('waiting');
      expect(readFileSync(path.join(project.path, 'c.txt'), 'utf8')).toBe('after');
    } finally {
      pause.release();
      await Promise.allSettled([commit, stage, restore]);
    }
    await Promise.all([commit, stage, restore]);
    expect(project.git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.txt');
    expect(project.git('diff', '--cached', '--name-only').trim()).toBe('b.txt');
    expect(readFileSync(path.join(project.path, 'c.txt'), 'utf8')).toBe('before');
  });

  it('releases the project lock after a rejected commit so later stage and restore can proceed', async () => {
    const f = fixture(),
      project = await f.project('project');
    await f.changes.stage(project.run.id, 'a.txt');
    await expect(f.changes.commit(project.id, 'invalid', '0'.repeat(64))).rejects.toThrow('变化');
    await f.changes.stage(project.run.id, 'b.txt');
    await f.changes.restore(project.run.id, 'c.txt');
    expect(project.git('log', '-1', '--format=%s').trim()).toBe('initial');
    expect(project.git('diff', '--cached', '--name-only').trim().split('\n')).toEqual([
      'a.txt',
      'b.txt',
    ]);
    expect(readFileSync(path.join(project.path, 'c.txt'), 'utf8')).toBe('before');
  });

  it('allows another project to stage while a reviewed commit is in progress', async () => {
    const f = fixture(),
      first = await f.project('first'),
      second = await f.project('second');
    await f.changes.stage(first.run.id, 'a.txt');
    const reviewed = await f.changes.staged(first.id);
    const pause = pauseCommit(f.changes);
    const commit = f.changes.commit(first.id, 'first', reviewed.hash);
    await pause.read;
    try {
      await f.changes.stage(second.run.id, 'b.txt');
      expect(second.git('diff', '--cached', '--name-only').trim()).toBe('b.txt');
      expect(first.git('log', '-1', '--format=%s').trim()).toBe('initial');
    } finally {
      pause.release();
      await commit;
    }
  });
});
