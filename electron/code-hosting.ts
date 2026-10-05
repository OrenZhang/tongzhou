import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Connector, PluginConfig, Project } from '../src/shared/types';
import { codeHost } from '../src/shared/code-hosting';
import type { Store } from './store';

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
  if (
    codeHost(config) !== 'github' ||
    config.authMode === 'oauth' ||
    account?.kind !== 'github' ||
    !account.enabled ||
    account.baseUrl.replace(/\/$/, '') !== 'https://github.com'
  )
    throw new Error('GitHub 插件绑定的账号已移除、停用或不匹配，请在工作插件中重新选择账号');
  const token = store.secret('connector_' + account.id);
  if (!token) throw new Error('GitHub 账号尚未授权，请在连接中心更新认证');
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
