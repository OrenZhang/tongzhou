import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from './validation';
import type { Store } from './store';
import type { Connector, GitRepositoryInfo, Project, Run, Session } from '../src/shared/types';

const exec = promisify(execFile);
export type GitRunner = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
const execute: GitRunner = async (cwd, args, env) =>
  (
    await exec('git', args, {
      cwd,
      env,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout;

export function repositoryUrl(value: string, site: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.origin !== new URL(site).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[\w.-]+(?:\/[\w.-]+)+\/?$/.test(url.pathname) ||
    url.pathname.split('/').some((s) => s === '.' || s === '..')
  )
    throw new Error('请使用所选账号站点的 HTTPS 仓库地址，不包含凭据或参数');
  return url.href.replace(/\/$/, '');
}

export class GitRepositories {
  private busy = new Set<string>();
  private hooksPath: string;
  constructor(
    private store: Store,
    dataDir: string,
    private changed: () => void,
    private run: GitRunner = execute,
  ) {
    this.hooksPath = path.join(dataDir, 'git-no-hooks');
  }
  private async git(
    cwd: string,
    args: string[],
    auth?: { url: string; token: string; kind: string },
  ) {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^GIT_(CONFIG|TRACE|CURL_VERBOSE|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|ASKPASS|SSH)/i.test(
          key,
        )
      )
        delete env[key];
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GCM_INTERACTIVE = 'never';
    const config = [
      ['core.hooksPath', this.hooksPath],
      ['credential.helper', ''],
      ['core.askPass', ''],
      ['http.followRedirects', 'false'],
      ['protocol.allow', 'never'],
      ['protocol.https.allow', 'always'],
    ];
    if (auth) {
      const user = auth.kind === 'gitlab' ? 'oauth2' : 'x-access-token';
      config.push([`http.${auth.url}.extraHeader`, '']);
      config.push([
        `http.${auth.url}.extraHeader`,
        'Authorization: Basic ' + Buffer.from(user + ':' + auth.token).toString('base64'),
      ]);
    }
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], i) => {
      env['GIT_CONFIG_KEY_' + i] = key;
      env['GIT_CONFIG_VALUE_' + i] = value;
    });
    await mkdir(this.hooksPath, { recursive: true });
    try {
      return await this.run(cwd, args, env);
    } catch {
      throw new Error('Git 操作未完成，请检查 Git 安装、网络、仓库权限及分支状态。');
    }
  }
  private account(id: string) {
    const c = this.store.get<Connector>('connector', idSchema.parse(id));
    if (!c.enabled || !['github', 'gitlab'].includes(c.kind))
      throw new Error('请选择已启用的代码托管账号');
    const token = this.store.secret('connector_' + c.id);
    if (!token) throw new Error('请先在连接中心完成账号授权或保存访问令牌');
    return { c, token };
  }
  private async project(id: string) {
    const p = this.store.get<Project>('project', idSchema.parse(id));
    if (p.removed) throw new Error('工作目录已移除');
    const root = await realpath(p.path);
    const top = await realpath((await this.git(root, ['rev-parse', '--show-toplevel'])).trim());
    if (path.relative(root, top)) throw new Error('请添加仓库根目录后操作');
    return p;
  }
  async info(id: string): Promise<GitRepositoryInfo> {
    const p = await this.project(id);
    const branch = (
      await this.git(p.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
    ).trim();
    const remote = (await this.git(p.path, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
    // Never return credentials embedded in a pre-existing remote URL to the renderer or model.
    const safeRemote = remote.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1').replace(/[?#].*$/, '');
    return {
      branch,
      remote: safeRemote,
      connectorId: p.gitConnectorId ?? '',
      dirty: !!(await this.git(p.path, ['status', '--porcelain'])).trim(),
    };
  }
  async bind(id: string, connectorId: string) {
    const p = await this.project(id);
    if (connectorId) {
      const { c } = this.account(connectorId);
      const remote = (await this.git(p.path, ['remote', 'get-url', 'origin'])).trim();
      repositoryUrl(remote, c.baseUrl);
    }
    this.store.put('project', { ...p, gitConnectorId: connectorId || undefined });
    this.changed();
  }
  async clone(connectorId: string, rawUrl: string, rawDirectory: string) {
    const { c, token } = this.account(connectorId);
    const url = repositoryUrl(z.string().max(2000).parse(rawUrl), c.baseUrl);
    const directory = z.string().min(1).max(2000).parse(rawDirectory);
    if (!path.isAbsolute(directory)) throw new Error('请选择绝对路径');
    const parent = await realpath(path.dirname(directory));
    const target = path.join(parent, path.basename(directory));
    // Exclusive creation prevents overwriting an existing folder, including an empty one.
    try {
      await mkdir(target);
    } catch {
      throw new Error('目标目录已存在或无法创建，请选择新的目录名称');
    }
    try {
      await this.git(parent, ['clone', '--no-checkout', '--', url, target], {
        url,
        token,
        kind: c.kind,
      });
      // Checkout and any repository filters never receive the account credential.
      if ((await this.git(target, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).trim())
        await this.git(target, ['checkout']);
    } catch (e) {
      throw new Error(`${(e as Error).message} 已保留克隆目录：${target}`);
    }
    const project = this.store.put('project', {
      id: randomUUID(),
      name: path.basename(target),
      path: target,
      createdAt: Date.now(),
      gitConnectorId: c.id,
    }) as Project;
    this.changed();
    return project;
  }
  async sync(id: string, action: 'pull' | 'push') {
    z.enum(['pull', 'push']).parse(action);
    const p = await this.project(id);
    if (!p.gitConnectorId) throw new Error('请先为此项目选择代码托管账号');
    const { c, token } = this.account(p.gitConnectorId);
    const common = await realpath(
      (await this.git(p.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
    );
    const key = process.platform === 'win32' ? common.toLowerCase() : common;
    if (this.busy.has(key)) throw new Error('此仓库正在同步，请稍后重试');
    this.busy.add(key);
    try {
      const info = await this.info(id);
      if (!info.branch) throw new Error('当前是游离 HEAD，请先切换到分支');
      await this.git(p.path, ['check-ref-format', '--branch', info.branch]);
      const remote = (
        await this.git(p.path, [
          'remote',
          'get-url',
          ...(action === 'push' ? ['--push'] : []),
          '--all',
          'origin',
        ])
      )
        .trim()
        .split(/\r?\n/);
      if (remote.length !== 1) throw new Error('origin 包含多个地址，请先整理远程配置');
      const url = repositoryUrl(remote[0], c.baseUrl);
      const auth = { url, token, kind: c.kind };
      const branchRef = 'refs/heads/' + info.branch;
      if (action === 'pull') {
        const related = this.store
          .list<Project>('project')
          .filter(
            (v) =>
              v.id === p.id ||
              v.sourceProjectId === (p.sourceProjectId || p.id) ||
              v.id === p.sourceProjectId,
          )
          .map((v) => v.id);
        const sessions = this.store
          .list<Session>('session')
          .filter((s) => s.projectId && related.includes(s.projectId));
        if (
          this.store
            .list<Run>('run')
            .some((r) => r.status === 'running' && sessions.some((s) => s.id === r.sessionId))
        )
          throw new Error('项目会话正在执行，请结束后再拉取');
        if (info.dirty) throw new Error('请先提交或暂存工作区修改，再拉取代码');
        const before = (await this.git(p.path, ['rev-parse', 'HEAD'])).trim();
        const tracking = 'refs/remotes/origin/' + info.branch;
        await this.git(
          p.path,
          ['fetch', '--no-tags', '--no-recurse-submodules', '--', url, branchRef + ':' + tracking],
          auth,
        );
        if (
          (await this.git(p.path, ['rev-parse', 'HEAD'])).trim() !== before ||
          (await this.info(id)).dirty
        )
          throw new Error('拉取期间工作区已变化，已保留远程更新，请检查后重试');
        try {
          await this.git(p.path, ['merge', '--ff-only', '--', tracking]);
        } catch {
          throw new Error('分支已分叉或无法快进，请在项目中处理后再拉取；未覆盖本地提交');
        }
      } else {
        const head = (await this.git(p.path, ['rev-parse', 'HEAD'])).trim();
        const tracking = 'refs/remotes/origin/' + info.branch;
        const previous = (
          await this.git(p.path, ['rev-parse', '--verify', tracking]).catch(() => '')
        ).trim();
        await this.git(
          p.path,
          [
            'push',
            '--no-follow-tags',
            '--recurse-submodules=no',
            '--',
            url,
            head + ':' + branchRef,
          ],
          auth,
        );
        const fetchUrl = (await this.git(p.path, ['remote', 'get-url', 'origin'])).trim();
        if (fetchUrl === url)
          await this.git(p.path, [
            'update-ref',
            tracking,
            head,
            previous || '0'.repeat(head.length),
          ]).catch(() => {});
      }
      this.changed();
      return action === 'pull' ? '已拉取远程更新' : '已推送当前分支的提交';
    } finally {
      this.busy.delete(key);
    }
  }
}
