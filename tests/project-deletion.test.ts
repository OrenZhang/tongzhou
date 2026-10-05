import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { Runtime } from '../electron/runtime';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-project-delete-'));
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  const runtime = new Runtime(store, root, () => {});
  cleanups.push(async () => {
    runtime.stop();
    await runtime.waitForIdle();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.put('project', { id: 'p', name: '项目', path: root, createdAt: 1 });
  const session = store.createSession('p');
  return { root, store, runtime, session };
}
describe('project deletion', () => {
  it('requires the confirmed complete session set and rejects a stale confirmation', async () => {
    const { store, runtime } = await fixture();
    expect(() => runtime.deleteProject('p')).toThrow('重新打开');
    const confirmed = runtime.projectDeletionPreview('p');
    const archived = store.createSession('p');
    store.put('session', { ...archived, archived: true });
    expect(() => runtime.deleteProject('p', confirmed)).toThrow('2 个会话');
    expect(runtime.projectDeletionPreview('p')).toHaveLength(2);
  });
  it('deletes the complete project family and records while preserving files and unrelated sessions', async () => {
    const { root, store, runtime, session } = await fixture();
    const file = path.join(root, 'keep.txt');
    await writeFile(file, 'user file');
    store.put('project', {
      id: 'worktree',
      name: '分支',
      sourceProjectId: 'p',
      path: root,
      createdAt: 2,
    });
    store.put('worktree', { id: 'worktree', sourceProjectId: 'p', path: root });
    const branch = store.createSession('worktree');
    store.put('session', { ...branch, archived: true });
    const child = store.createSession();
    store.put('session', { ...child, parentId: session.id, memoryJob: true });
    const other = store.createSession();
    for (const id of [session.id, branch.id, child.id]) {
      store.message({
        id: 'msg-' + id,
        sessionId: id,
        role: 'user',
        content: 'history',
        createdAt: 1,
      });
      store.put('run', { id: 'run-' + id, sessionId: id, status: 'completed' });
      store.put('terminal', { id: 'terminal-' + id, sessionId: id, status: 'exited' });
      store.put('taskMemory', { id, sessionId: id });
    }
    store.put('channel', { id: 'channel', sessionId: session.id, inbound: true });
    expect(runtime.deleteProject('p', runtime.projectDeletionPreview('p')).sort()).toEqual(
      [session.id, branch.id, child.id].sort(),
    );
    expect(store.list('project')).toEqual([]);
    expect(store.list('worktree')).toEqual([]);
    expect(store.list('session').map((s) => s.id)).toEqual([other.id]);
    for (const kind of ['run', 'terminal', 'taskMemory']) expect(store.list(kind)).toEqual([]);
    expect(store.messages(session.id)).toEqual([]);
    expect(store.get<any>('channel', 'channel').inbound).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('user file');
  });
  it('blocks active runs, terminals and queued work without deleting records', async () => {
    const { store, runtime, session } = await fixture();
    store.put('run', { id: 'r', sessionId: session.id, status: 'running' });
    expect(() => runtime.deleteProject('p')).toThrow('运行中的任务');
    store.remove('run', 'r');
    store.put('terminal', { id: 't', sessionId: session.id, status: 'running' });
    expect(() => runtime.deleteProject('p')).toThrow('运行中的终端');
    store.remove('terminal', 't');
    store.put('pendingInput', { id: 'q', sessionId: session.id, status: 'queued' });
    expect(() => runtime.deleteProject('p')).toThrow('排队');
    expect(store.get('session', session.id)).toBeTruthy();
    expect(store.get('project', 'p')).toBeTruthy();
  });
  it('can delete an empty project whose original directory no longer exists', async () => {
    const { store, runtime } = await fixture();
    store.put('project', {
      id: 'empty',
      name: '失效目录',
      path: 'nonexistent-folder',
      createdAt: 1,
    });
    expect(runtime.deleteProject('empty')).toEqual([]);
    expect(store.list('project').map((p) => p.id)).toEqual(['p']);
  });
  it('rolls back session deletion if removing the project fails', async () => {
    const { store, runtime, session } = await fixture();
    store.db.exec(
      "CREATE TRIGGER fail_project BEFORE DELETE ON objects WHEN OLD.kind='project' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    expect(() => runtime.deleteProject('p', runtime.projectDeletionPreview('p'))).toThrow(
      'fixture failure',
    );
    expect(store.get('session', session.id)).toBeTruthy();
    expect(store.get('project', 'p')).toBeTruthy();
    expect(store.list('deletedSession')).toEqual([]);
  });
});
