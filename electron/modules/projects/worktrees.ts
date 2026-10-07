import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../services/storage/store';
import type { Project, Session, Run, WorktreeInfo } from '../../../src/shared/types';
const exec = promisify(execFile);
interface Owned {
  id: string;
  sourceProjectId: string;
  path: string;
  base: string;
  branch: string;
}
const equalPath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
export function parseWorktrees(raw: string): WorktreeInfo[] {
  const rows: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;
  for (const token of raw.split('\0')) {
    if (token.startsWith('worktree ')) {
      current = {
        path: token.slice(9),
        branch: '',
        head: '',
        main: rows.length === 0,
        managed: false,
        dirty: false,
        locked: false,
        prunable: false,
        unsharedCommits: false,
      };
      rows.push(current);
    } else if (current) {
      if (token.startsWith('HEAD ')) current.head = token.slice(5);
      if (token.startsWith('branch '))
        current.branch = token.slice(7).replace(/^refs\/heads\//, '');
      if (token.startsWith('locked')) current.locked = true;
      if (token.startsWith('prunable')) current.prunable = true;
    }
  }
  return rows;
}
export class Worktrees {
  private busy = new Set<string>();
  private removing = new Set<string>();
  isRemoving(id: string) {
    return this.removing.has(id);
  }
  private root: string;
  constructor(
    private store: Store,
    dataDir: string,
    private changed: () => void,
  ) {
    this.root = path.resolve(dataDir, 'worktrees');
  }
  private async git(cwd: string, args: string[]) {
    try {
      return (
        await exec('git', ['-c', 'core.quotepath=false', ...args], {
          cwd,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        })
      ).stdout;
    } catch {
      throw new Error('Git 操作失败，请检查仓库、分支名称、文件占用和 Git 安装。');
    }
  }
  private async repository(projectId: string) {
    const p = this.store.get<Project>('project', projectId);
    if (p.removed) throw new Error('该工作树已移除');
    const root = await realpath(p.path);
    const top = (await this.git(root, ['rev-parse', '--show-toplevel'])).trim();
    return await realpath(top);
  }
  private async unshared(owned: Owned, root: string, head: string) {
    if (head === owned.base) return false;
    const remotes = (
      await this.git(root, [
        'for-each-ref',
        '--format=%(refname)',
        '--contains=' + head,
        'refs/remotes',
      ])
    ).trim();
    if (remotes) return false;
    const source = this.store.get<Project>('project', owned.sourceProjectId);
    try {
      await this.git(source.path, ['merge-base', '--is-ancestor', head, 'HEAD']);
      return false;
    } catch {
      return true;
    }
  }
  async list(projectId: string) {
    const root = await this.repository(projectId);
    const rows = parseWorktrees(await this.git(root, ['worktree', 'list', '--porcelain', '-z']));
    for (const row of rows) {
      const owned = this.store.list<Owned>('worktree').find((o) => equalPath(o.path, row.path));
      row.managed = !!owned;
      row.projectId =
        owned?.id ??
        this.store.list<Project>('project').find((p) => !p.removed && equalPath(p.path, row.path))
          ?.id;
      if (!row.prunable) {
        try {
          row.dirty = !!(
            await this.git(row.path, [
              'status',
              '--porcelain',
              '--untracked-files=all',
              '--ignored',
            ])
          ).trim();
          if (owned) row.unsharedCommits = await this.unshared(owned, row.path, row.head);
        } catch {
          row.prunable = true;
        }
      }
    }
    return rows;
  }
  private async lock<T>(projectId: string, fn: (root: string) => Promise<T>) {
    const root = await this.repository(projectId);
    const common = (
      await this.git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    const key = process.platform === 'win32' ? common.toLowerCase() : common;
    if (this.busy.has(key)) throw new Error('此仓库正在处理工作树，请稍后重试');
    this.busy.add(key);
    try {
      return await fn(root);
    } finally {
      this.busy.delete(key);
    }
  }
  async create(projectId: string, rawBranch: string, rawRef: string): Promise<Project> {
    const branch = z.string().trim().min(1).max(160).parse(rawBranch),
      ref = z.string().trim().min(1).max(200).parse(rawRef);
    if (branch.startsWith('-') || ref.startsWith('-')) throw new Error('分支或来源不能以 - 开头');
    return this.lock(projectId, async (root) => {
      await this.git(root, ['check-ref-format', '--branch', branch]);
      const base = (
        await this.git(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])
      ).trim();
      const id = randomUUID(),
        target = path.join(this.root, id),
        hooks = path.join(this.root, '.empty-hooks');
      await mkdir(hooks, { recursive: true });
      await this.git(root, [
        '-c',
        'core.hooksPath=' + hooks,
        'worktree',
        'add',
        '-b',
        branch,
        '--',
        target,
        base,
      ]);
      const original = this.store.get<Project>('project', projectId);
      let source = original;
      const seen = new Set<string>();
      while (source.sourceProjectId && !seen.has(source.id)) {
        seen.add(source.id);
        source = this.store.get<Project>('project', source.sourceProjectId);
      }
      const p: Project = {
        id,
        name: original.name + ' · ' + branch,
        path: await realpath(target),
        createdAt: Date.now(),
        sourceProjectId: source.id,
        gitConnectorId: original.gitConnectorId,
      };
      this.store.put('worktree', { id, sourceProjectId: source.id, path: p.path, base, branch });
      this.store.put('project', p);
      this.changed();
      return p;
    });
  }
  async remove(projectId: string) {
    const o = this.store.list<Owned>('worktree').find((x) => x.id === projectId);
    if (!o) throw new Error('只能移除由同舟创建的工作树');
    return this.lock(o.sourceProjectId, async (root) => {
      this.removing.add(projectId);
      try {
        const managedRoot = await realpath(this.root),
          target = await realpath(o.path);
        const relative = path.relative(managedRoot, target);
        if (
          !relative ||
          relative.startsWith('..') ||
          path.isAbsolute(relative) ||
          !equalPath(path.join(managedRoot, o.id), target) ||
          (await lstat(o.path)).isSymbolicLink()
        )
          throw new Error('工作树路径不在同舟管理目录内');
        const row = (await this.list(o.sourceProjectId)).find((r) => equalPath(r.path, target));
        if (!row || row.main || !row.managed || row.locked || row.prunable)
          throw new Error('此工作树不是可移除的同舟工作树');
        const sessions = this.store
          .list<Session>('session')
          .filter((s) => s.projectId === projectId);
        if (
          this.store
            .list<Run>('run')
            .some((r) => sessions.some((s) => s.id === r.sessionId) && r.status === 'running')
        )
          throw new Error('工作树仍有运行中的会话');
        if (row.dirty) throw new Error('工作树包含未提交、未跟踪或被忽略的文件，请先保存或清理');
        if (row.unsharedCommits)
          throw new Error('工作树包含尚未推送或合并的提交，请先保存到远端或主分支');
        if (/(^|\n)160000 /.test(await this.git(target, ['ls-files', '--stage'])))
          throw new Error('含子模块的工作树请使用 Git 手动管理');
        await this.git(root, ['worktree', 'remove', '--', target]);
        this.store.remove('worktree', projectId);
        this.store.put('project', {
          ...this.store.get<Project>('project', projectId),
          removed: true,
        });
        for (const s of sessions) this.store.put('session', { ...s, archived: true });
        this.changed();
      } finally {
        this.removing.delete(projectId);
      }
    });
  }
}
