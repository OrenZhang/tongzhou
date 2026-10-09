import { createHash, randomUUID } from 'node:crypto';
import type { LocalGitlabAccount, PluginConfig } from '../../../src/shared/types';
import { serviceFetch } from '../network/service-network';
import { serviceUrl } from './connectors';
import {
  credentialToken,
  localCredentialCommand,
  readGitCredential,
  type LocalCredentialCommand,
} from './local-credentials';
import type { Store } from '../storage/store';

export function gitlabInstance(value: string) {
  const url = serviceUrl(value.trim());
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('GitLab 实例只填写 HTTPS 站点根地址');
  return url.origin;
}
export async function readLocalGitlabCredential(
  source: LocalGitlabAccount['source'],
  baseUrl: string,
  run: LocalCredentialCommand = localCredentialCommand,
) {
  const url = new URL(gitlabInstance(baseUrl));
  if (source === 'git') return readGitCredential(url, run);
  // auth status resolves both config-file and OS keyring storage. Capture privately.
  const output = await run(
    'glab',
    ['auth', 'status', '--hostname', url.host, '--show-token'],
    undefined,
    true,
  );
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const token = /\bToken(?: found in [^:\r\n]+)?:\s*(\S+)/i.exec(plain)?.[1] ?? '';
  if (/^\*+$/.test(token)) throw new Error('GitLab CLI 未返回可用凭据');
  return credentialToken(token);
}
export async function verifyLocalGitlabIdentity(baseUrl: string, token: string) {
  const origin = gitlabInstance(baseUrl);
  try {
    const response = await serviceFetch(origin + '/api/v4/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('invalid');
    const body = (await response.json()) as { id?: number; username?: string };
    if (
      !Number.isSafeInteger(body.id) ||
      !body.id ||
      body.id < 0 ||
      typeof body.username !== 'string' ||
      !/^[\w.-]{1,100}$/.test(body.username)
    )
      throw new Error('invalid');
    return { id: String(body.id), login: body.username };
  } catch {
    throw new Error('本地登录未验证通过，请检查 GitLab 实例、网络或重新登录');
  }
}

export class LocalGitlabAccounts {
  private candidates = new Map<
    string,
    { token: string; accountId: string; metadata: LocalGitlabAccount }
  >();
  private revisions = new Map<string, number>();
  private dependencies: {
    read: typeof readLocalGitlabCredential;
    identity: typeof verifyLocalGitlabIdentity;
  };
  constructor(
    private store: Store,
    dependencies: Partial<LocalGitlabAccounts['dependencies']> = {},
  ) {
    this.dependencies = {
      read: readLocalGitlabCredential,
      identity: verifyLocalGitlabIdentity,
      ...dependencies,
    };
  }
  async detect(instance: string): Promise<LocalGitlabAccount[]> {
    const baseUrl = gitlabInstance(instance);
    const revision = (this.revisions.get(baseUrl) ?? 0) + 1;
    this.revisions.set(baseUrl, revision);
    for (const [id, candidate] of this.candidates)
      if (candidate.metadata.baseUrl === baseUrl) this.candidates.delete(id);
    return Promise.all(
      (['git', 'glab'] as const).map(async (source) => {
        const metadata: LocalGitlabAccount = {
          id: randomUUID(),
          baseUrl,
          source,
          status: 'unavailable',
        };
        let token: string;
        try {
          token = await this.dependencies.read(source, baseUrl);
        } catch {
          return metadata;
        }
        try {
          const account = await this.dependencies.identity(baseUrl, token);
          metadata.status = 'verified';
          metadata.account = account.login;
          metadata.expiresAt = Date.now() + 5 * 60000;
          if (this.revisions.get(baseUrl) === revision) {
            this.candidates.set(metadata.id, { token, accountId: account.id, metadata });
            setTimeout(() => this.candidates.delete(metadata.id), 5 * 60000).unref();
          }
        } catch {
          metadata.status = 'unverified';
        }
        return metadata;
      }),
    );
  }
  async use(id: string): Promise<PluginConfig> {
    const candidate = this.candidates.get(id);
    if (!candidate || (candidate.metadata.expiresAt ?? 0) <= Date.now()) {
      this.candidates.delete(id);
      throw new Error('检测结果已过期，请重新检测本地账号');
    }
    const { baseUrl, source } = candidate.metadata;
    const account = await this.dependencies.identity(baseUrl, candidate.token);
    if (account.id !== candidate.accountId) throw new Error('账号已变更，请重新检测');
    if (this.candidates.get(id) !== candidate || (candidate.metadata.expiresAt ?? 0) <= Date.now())
      throw new Error('检测结果已过期，请重新检测本地账号');
    const site = createHash('sha256').update(baseUrl).digest('hex').slice(0, 16);
    const connectorId = `local-gitlab-${site}-${source}-${account.id}`;
    const pluginId = `tongzhou-${connectorId}-token`;
    const previous = this.store.list<PluginConfig>('plugin').find((p) => p.id === pluginId);
    if (previous && (previous.url !== baseUrl + '/api/v4/mcp' || previous.authMode !== 'headers'))
      throw new Error('插件配置已变更，请从管理连接中配置');
    const plugin: PluginConfig = previous
      ? {
          ...previous,
          ...(this.store.secret('connector_' + connectorId) !== candidate.token
            ? { catalog: undefined, checkedAt: undefined }
            : {}),
        }
      : {
          id: pluginId,
          name: `GitLab · ${account.login}（本地）`,
          transport: 'http',
          command: '',
          args: [],
          url: baseUrl + '/api/v4/mcp',
          authMode: 'headers',
          connectorId,
          enabled: false,
          readOnlyTools: [],
        };
    // Token mode uses the official REST API and never changes existing MCP OAuth grants.
    this.store.db.exec('BEGIN');
    try {
      this.store.saveSecret('connector_' + connectorId, candidate.token);
      this.store.put('connector', {
        id: connectorId,
        kind: 'gitlab',
        name: `GitLab · ${account.login}（本地）`,
        baseUrl,
        enabled: true,
        status: 'connected',
        account: account.login,
        checkedAt: Date.now(),
        localSource: source,
      });
      this.store.put('plugin', plugin);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.candidates.delete(id);
    return plugin;
  }
}
