import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { ChangeCheckpoints } from '../../../electron/modules/projects/run-changes';
import { registerTaskServices } from '../../../electron/modules/sessions/task-services';
import { ClientCommands } from '../../../electron/core/tools/client-commands';
import { ToolScope } from '../../../electron/core/tools/extensions';
import type { Run } from '../../../src/shared/types';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-delivery-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const project = { id: 'project', name: 'project', path: path.join(root, 'repo'), createdAt: 1 };
  mkdirSync(project.path);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: project.path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(project.path, 'code.txt'), 'before');
  git('add', 'code.txt');
  git('commit', '-m', 'initial');
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  cleanup.push(() => store.close());
  store.put('project', project);
  const session = store.createSession(project.id);
  const checkpoints = new ChangeCheckpoints(store, root);
  await checkpoints.begin('previous', session.id, project);
  writeFileSync(path.join(project.path, 'code.txt'), 'after');
  await checkpoints.finish('previous');
  store.put('run', { id: 'active', sessionId: session.id, status: 'running', startedAt: 1 });
  const commands = new ClientCommands();
  registerTaskServices(
    commands.register.bind(commands),
    store,
    { checkpoints, snapshot: () => ({ runs: store.list<Run>('run') }) } as any,
    root,
    { dialogs: {} } as any,
  );
  const attach = (sessionId = session.id, approved = true) => {
    const scope = new ToolScope(
      new AbortController().signal,
      async () => approved,
      () => {},
    );
    commands.attach(scope, false, () => true, sessionId);
    cleanup.push(() => scope.close());
    return scope;
  };
  const scope = attach();
  const change = (method: string, args: unknown[], target = scope) =>
    target.call('client_change', { method, args });
  return { store, project, session, commands, checkpoints, git, attach, change, scope };
}

describe('coding task delivery through application tools', () => {
  it('can stage and commit reviewed changes from its own active task without weakening UI idle checks', async () => {
    const f = await fixture();
    expect(() => f.commands.invoke('stageRunFile', ['previous', 'code.txt'])).toThrow('停止');
    expect((await f.change('stageRunFile', ['previous', 'code.txt'])).isError).not.toBe(true);
    const staged = JSON.parse(
      (await f.scope.call('client_query', { method: 'reviewStaged', args: [f.project.id] })).text,
    );
    expect(staged.patch).toContain('+after');
    expect(
      (await f.change('commitStaged', [f.project.id, 'deliver', staged.hash])).isError,
    ).not.toBe(true);
    expect(f.git('log', '-1', '--format=%s').trim()).toBe('deliver');
    expect(f.git('status', '--porcelain')).toBe('');
  });

  it('still rejects denied approvals, other active project tasks, native children and changed staged content', async () => {
    const f = await fixture();
    const denied = f.attach(f.session.id, false);
    expect((await f.change('stageRunFile', ['previous', 'code.txt'], denied)).isError).toBe(true);
    expect(f.git('diff', '--cached')).toBe('');
    const other = f.store.createSession(f.project.id);
    f.store.put('run', { id: 'other', sessionId: other.id, status: 'running', startedAt: 2 });
    expect((await f.change('stageRunFile', ['previous', 'code.txt'])).isError).toBe(true);
    f.store.put('run', { id: 'other', sessionId: other.id, status: 'completed', startedAt: 2 });
    const active = f.store.get<Run>('run', 'active');
    f.store.put('run', {
      ...active,
      agents: [{ threadId: 'child', parentThreadId: 'parent', name: 'child', status: 'running' }],
    });
    expect((await f.change('stageRunFile', ['previous', 'code.txt'])).isError).toBe(true);
    f.store.put('run', active);
    const outsider = f.attach(f.store.createSession().id);
    expect((await f.change('stageRunFile', ['previous', 'code.txt'], outsider)).isError).toBe(true);
    await f.change('stageRunFile', ['previous', 'code.txt']);
    const staged = await f.checkpoints.staged(f.project.id);
    writeFileSync(path.join(f.project.path, 'code.txt'), 'newer user edit');
    f.git('add', 'code.txt');
    const result = await f.change('commitStaged', [f.project.id, 'must not commit', staged.hash]);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('变化');
    expect(f.git('log', '-1', '--format=%s').trim()).toBe('initial');
  });

  it('can restore a finished checkpoint while preserving later user edits', async () => {
    const f = await fixture();
    writeFileSync(path.join(f.project.path, 'code.txt'), 'newer user edit');
    expect((await f.change('restoreRunFile', ['previous', 'code.txt'])).isError).toBe(true);
    expect(readFileSync(path.join(f.project.path, 'code.txt'), 'utf8')).toBe('newer user edit');
    writeFileSync(path.join(f.project.path, 'code.txt'), 'after');
    expect((await f.change('restoreRunFile', ['previous', 'code.txt'])).isError).not.toBe(true);
    expect(readFileSync(path.join(f.project.path, 'code.txt'), 'utf8')).toBe('before');
  });
});
