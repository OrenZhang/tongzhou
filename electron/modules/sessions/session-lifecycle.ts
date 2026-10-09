import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Project, Session, Run, PendingInput } from '../../../src/shared/types';
import { projectDeletionTargets } from '../../../src/shared/projects';
import { engineHome } from '../../services/accounts/account-paths';
import type { Store } from '../../services/storage/store';

export interface SessionExecution {
  isActive(id: string): boolean;
  removeEngineSession(id: string): unknown | Promise<unknown>;
  stopTerminalSession(id: string): void;
  changed(): void;
}

export class SessionLifecycle {
  private deleting = new Set<string>();
  constructor(
    private store: Store,
    private dataDir: string,
    private ports: SessionExecution,
  ) {}
  isDeleting(id: string) {
    return this.deleting.has(id);
  }
  projectDeletionPreview(id: string) {
    this.store.get<Project>('project', id);
    return [
      ...projectDeletionTargets(
        this.store.list<Project>('project'),
        this.store.list<Session>('session'),
        id,
      ).sessionIds,
    ].sort();
  }
  deleteProject(id: string, expectedSessionIds?: string[]) {
    this.store.get<Project>('project', id);
    const { projectIds, sessionIds } = projectDeletionTargets(
      this.store.list<Project>('project'),
      this.store.list<Session>('session'),
      id,
    );
    if ([...sessionIds].some((s) => this.deleting.has(s)))
      throw new Error('正在处理项目内的会话删除，请稍后重试。');
    if (
      [...sessionIds].some((s) => this.ports.isActive(s)) ||
      this.store.list<Run>('run').some((r) => sessionIds.has(r.sessionId) && r.status === 'running')
    )
      throw new Error('项目仍有运行中的任务，请先停止任务再删除。');
    if (
      this.store
        .list<{ id: string; sessionId: string; status: string }>('terminal')
        .some((t) => sessionIds.has(t.sessionId) && t.status === 'running')
    )
      throw new Error('项目仍有运行中的终端，请先停止终端再删除（关闭面板不会停止进程）。');
    if (
      this.store
        .list<PendingInput>('pendingInput')
        .some((p) => sessionIds.has(p.sessionId) && ['queued', 'dispatching'].includes(p.status))
    )
      throw new Error('项目仍有排队中的任务，请先取消排队再删除。');
    // Synchronous transaction: no new task or terminal can start between checks and deletion.
    if (
      JSON.stringify([...sessionIds].sort()) !==
      JSON.stringify([...(expectedSessionIds ?? [])].sort())
    )
      throw new Error(
        `项目包含 ${sessionIds.size} 个会话，或会话已发生变化，请重新打开删除确认框核对。`,
      );
    // Remove registrations only; never remove project or Git worktree directories from disk.
    this.store.deleteProject(projectIds, sessionIds);
    for (const s of sessionIds) this.ports.removeEngineSession(s);
    this.ports.changed();
    return [...sessionIds];
  }
  async deleteSession(id: string) {
    if (!this.store.get<Session>('session', id).archived) throw new Error('请先归档会话，再删除');
    const targets = new Set([id]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const s of this.store.list<Session>('session'))
        if (s.parentId && targets.has(s.parentId) && !targets.has(s.id)) {
          targets.add(s.id);
          changed = true;
        }
    }
    if ([...targets].some((target) => this.deleting.has(target)))
      throw new Error('会话正在删除，请稍候');
    if (
      [...targets].some((target) => this.ports.isActive(target)) ||
      this.store.list<Run>('run').some((r) => targets.has(r.sessionId) && r.status === 'running')
    )
      throw new Error('请先停止会话及内部子会话的任务，再删除');
    for (const target of targets) this.deleting.add(target);
    try {
      await Promise.all([...targets].map((target) => this.ports.removeEngineSession(target)));
      const root = path.resolve(this.dataDir, 'chat-workspaces');
      for (const target of targets) {
        const directory = path.resolve(root, target);
        const relative = path.relative(root, directory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
          throw new Error('无效的会话数据路径');
        await rm(directory, { recursive: true, force: true });
        for (const provider of this.store.providers()) {
          const sessionsRoot = path.resolve(
            engineHome(this.dataDir, 'codex', provider.id),
            'sessions',
          );
          const engineDirectory = path.resolve(sessionsRoot, target);
          const relativeEngine = path.relative(sessionsRoot, engineDirectory);
          if (!relativeEngine || relativeEngine.startsWith('..') || path.isAbsolute(relativeEngine))
            throw new Error('无效的执行会话路径');
          await rm(engineDirectory, { recursive: true, force: true });
        }
      }
      for (const target of targets) this.ports.stopTerminalSession(target);
      this.store.deleteSession(id);
      this.ports.changed();
    } finally {
      for (const target of targets) this.deleting.delete(target);
    }
  }
}
