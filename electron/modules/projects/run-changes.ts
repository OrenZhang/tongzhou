import { managedDirectory } from '../../services/storage/local-files';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { commandResult, within, withFileLock } from '../../core/tools/workspace';
import type { Store } from '../../services/storage/store';
import type { RunChanges } from '../../../src/shared/task';
import type { Project } from '../../../src/shared/types';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const excluded =
  /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx))($|\/)/i;
export class ChangeCheckpoints {
  constructor(
    private store: Store,
    private dataDir: string,
  ) {}
  private root() {
    return managedDirectory(this.dataDir, 'checkpoints');
  }
  private blob(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效检查点');
    return path.join(this.root(), id);
  }
  private async capture(root: string) {
    const result = new Map<string, string>();
    let skipped = 0,
      bytes = 0,
      count = 0;
    const walk = async (dir: string) => {
      const entries = await readdir(await within(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        const rel = (dir ? dir + '/' : '') + entry.name;
        if (excluded.test(rel) || entry.isSymbolicLink()) {
          skipped++;
          continue;
        }
        if (++count > 4000) {
          skipped++;
          continue;
        }
        if (entry.isDirectory()) {
          await walk(rel);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const file = await within(root, rel);
          const stat = await lstat(file);
          if (stat.size > 1024 * 1024 || bytes + stat.size > 20 * 1024 * 1024) {
            skipped++;
            continue;
          }
          const data = await readFile(file);
          if (data.includes(0)) {
            skipped++;
            continue;
          }
          bytes += data.length;
          const id = hash(data);
          await writeFile(this.blob(id), data, { flag: 'wx' }).catch((e) => {
            if (e.code !== 'EEXIST') throw e;
          });
          result.set(rel, id);
        } catch {
          skipped++;
        }
      }
    };
    await mkdir(this.root(), { recursive: true });
    await walk('');
    return { result, skipped };
  }
  async begin(runId: string, sessionId: string, project: Project) {
    const captured = await this.capture(project.path);
    this.store.put('runChanges', {
      id: runId,
      sessionId,
      projectId: project.id,
      createdAt: Date.now(),
      skipped: captured.skipped,
      files: [...captured.result].map(([path, before]) => ({ path, before, after: before })),
    } satisfies RunChanges);
  }
  async finish(runId: string) {
    const checkpoint = this.store.get<RunChanges>('runChanges', runId);
    const project = this.store.get<Project>('project', checkpoint.projectId);
    const captured = await this.capture(project.path);
    const before = new Map(checkpoint.files.map((f) => [f.path, f.before]));
    const files: RunChanges['files'] = [];
    for (const name of new Set([...before.keys(), ...captured.result.keys()])) {
      const a = before.get(name) ?? null,
        b = captured.result.get(name) ?? null;
      // Excluded/oversized/unreadable files are not evidence of deletion.
      if (a && !b) {
        try {
          await lstat(await within(project.path, name));
          continue;
        } catch (e: any) {
          if (e.code !== 'ENOENT') continue;
        }
      }
      if (a !== b) files.push({ path: name, before: a, after: b });
    }
    return this.store.put('runChanges', {
      ...checkpoint,
      finishedAt: Date.now(),
      skipped: checkpoint.skipped + captured.skipped,
      files,
    });
  }
  list(sessionId: string) {
    return this.store
      .sessionObjects<RunChanges>('runChanges', sessionId, 30)
      .filter((r) => r.finishedAt);
  }
  async patch(runId: string, file: string) {
    const c = this.store.get<RunChanges>('runChanges', runId),
      f = c.files.find((f) => f.path === file);
    if (!f || !c.finishedAt) throw new Error('检查点文件不存在或仍在运行');
    return createTwoFilesPatch(
      file,
      file,
      f.before ? await readFile(this.blob(f.before), 'utf8') : '',
      f.after ? await readFile(this.blob(f.after), 'utf8') : '',
    );
  }
  async restore(runId: string, file: string) {
    const c = this.store.get<RunChanges>('runChanges', runId),
      f = c.files.find((f) => f.path === file);
    if (!f || !c.finishedAt) throw new Error('检查点文件不存在或仍在运行');
    const project = this.store.get<Project>('project', c.projectId);
    const target = await within(project.path, file, true);
    return withFileLock(target, async () => {
      const current = await readFile(target).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if ((current ? hash(current) : null) !== f.after)
        throw new Error('文件在本轮结束后已被修改，未覆盖。请先审阅最新差异。');
      // Never reset to HEAD: restore exactly the pre-turn user content.
      if (f.before) {
        const data = await readFile(this.blob(f.before));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data);
      } else await rm(target);
      f.restored = true;
      this.store.put('runChanges', c);
      return '已恢复到本轮开始前的内容';
    });
  }
  async stage(runId: string, file: string) {
    const c = this.store.get<RunChanges>('runChanges', runId),
      f = c.files.find((f) => f.path === file);
    if (!f || !c.finishedAt) throw new Error('检查点不存在');
    const project = this.store.get<Project>('project', c.projectId);
    const current = await readFile(await within(project.path, file, true)).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if ((current ? hash(current) : null) !== f.after)
      throw new Error('文件已变化，请重新审阅后暂存');
    const r = await commandResult(
      'git',
      ['--literal-pathspecs', 'add', '--', file],
      project.path,
      AbortSignal.timeout(15000),
      15000,
    );
    if (r.exitCode !== 0) throw new Error(r.output);
    return '已暂存文件';
  }
  async staged(projectId: string) {
    const p = this.store.get<Project>('project', projectId);
    const r = await commandResult(
      'git',
      ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'],
      p.path,
      AbortSignal.timeout(15000),
      15000,
    );
    if (r.exitCode !== 0 || r.truncated)
      throw new Error('无法完整读取已暂存差异，请缩小提交范围后重试');
    return { patch: r.stdout, hash: hash(Buffer.from(r.stdout)) };
  }
  async commit(projectId: string, message: string, expected: string) {
    if ((await this.staged(projectId)).hash !== expected)
      throw new Error('已暂存内容在审阅后发生变化，请重新检查');
    const p = this.store.get<Project>('project', projectId);
    const r = await commandResult(
      'git',
      ['commit', '-m', message],
      p.path,
      AbortSignal.timeout(120000),
      120000,
    );
    if (r.exitCode !== 0) throw new Error(r.output);
    return r.output;
  }
}
