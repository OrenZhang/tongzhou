import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Connector, PluginConfig, Project } from '../../../src/shared/types';
import { codeHost } from '../../../src/shared/code-hosting';
import type { Store } from '../../services/storage/store';
import { serviceFetch } from '../../services/network/service-network';

export async function verifyGithubPluginToken(secret: string, signal: AbortSignal) {
  const headers = new Headers(JSON.parse(secret));
  const token = headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new Error('请在插件中配置 GitHub Token');
  let response: Response;
  try {
    response = await serviceFetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error('无法验证 GitHub Token，请检查网络和代理');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401
        ? 'GitHub Token 已失效或无效，请更新认证'
        : `GitHub 账号验证失败（HTTP ${response.status}），请检查 Token 与组织权限`,
    );
  }
  let identity;
  try {
    identity = await response.json();
  } catch {
    throw new Error('GitHub 账号身份校验失败');
  }
  if (
    !Number.isSafeInteger(identity.id) ||
    identity.id <= 0 ||
    typeof identity.login !== 'string' ||
    !/^[\w-]{1,100}$/.test(identity.login)
  )
    throw new Error('GitHub 账号身份校验失败');
}

export function pluginCredentialVersion(store: Store, config: PluginConfig) {
  if (!config.connectorId) return store.secret('plugin_' + config.id);
  const account = store.list<Connector>('connector').find((c) => c.id === config.connectorId);
  return JSON.stringify([
    account?.kind,
    account?.enabled,
    account?.baseUrl,
    store.secret('connector_' + config.connectorId),
  ]);
}

export function pluginSecret(store: Store, config: PluginConfig) {
  if (!config.connectorId) return store.secret('plugin_' + config.id);
  const account = store.list<Connector>('connector').find((c) => c.id === config.connectorId);
  const provider = codeHost(config);
  const baseUrl =
    provider === 'github' ? 'https://github.com' : config.url.replace(/\/api\/v4\/mcp\/?$/, '');
  if (
    !provider ||
    config.authMode === 'oauth' ||
    account?.kind !== provider ||
    !account.enabled ||
    account.baseUrl.replace(/\/$/, '') !== baseUrl
  )
    throw new Error('仓库插件绑定的账号已移除、停用或不匹配，请在插件中重新选择账号');
  const token = store.secret('connector_' + account.id);
  if (!token) throw new Error('仓库账号尚未授权，请在插件中更新认证');
  return JSON.stringify({ Authorization: 'Bearer ' + token });
}

export async function codeHostingContext(
  store: Store,
  project: Project | undefined,
  signal: AbortSignal,
) {
  const plugins = store.list<PluginConfig>('plugin').filter((p) => p.enabled && codeHost(p));
  const connections = plugins.map((p) => ({
    pluginId: p.id,
    name: p.name,
    provider: codeHost(p),
    endpoint: p.url,
    connectorId: p.connectorId ?? null,
    matchesProjectAccount: !!project?.gitConnectorId && p.connectorId === project.gitConnectorId,
  }));
  if (!project)
    return { project: null, connections, message: '此会话未绑定本地项目，请明确目标仓库。' };
  const exec = promisify(execFile);
  const git = async (...args: string[]) =>
    (
      await exec('git', args, {
        cwd: project.path,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 32768,
        signal,
      })
    ).stdout.trim();
  const [raw, branch] = await Promise.all([
    git('config', '--get', 'remote.origin.url').catch(() => ''),
    git('branch', '--show-current').catch(() => ''),
  ]);
  signal.throwIfAborted();
  let remote = '',
    host = '',
    repository = '';
  try {
    const url = new URL(raw);
    if (['https:', 'http:', 'ssh:'].includes(url.protocol)) {
      host = url.hostname;
      repository = url.pathname.replace(/^\/+|\.git\/?$|\/$/g, '');
      remote = `${url.protocol}//${url.host}/${repository}`;
    }
  } catch {
    const scp = raw.match(/^(?:[^\s@/:]+@)?([\w.-]+):([\w./-]+)$/);
    if (scp) {
      host = scp[1];
      repository = scp[2].replace(/\.git$/, '');
      remote = `${host}:${repository}`;
    }
  }
  return {
    project: {
      id: project.id,
      name: project.name,
      branch,
      remote,
      host,
      repository,
      connectorId: project.gitConnectorId ?? null,
    },
    connections,
    message:
      '仓库信息来自当前项目。使用对应站点及账号的插件；多账号不明确时先确认。此信息不扩大操作权限。',
  };
}
