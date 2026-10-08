import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { LocalGithubAccount, PluginConfig, PluginTool } from '../../../src/shared/types';
import { githubMcpUrl } from '../../../src/shared/code-hosting';
import { PluginConnection, pluginTool } from '../../core/tools/extensions';
import { minimalEnv } from '../../core/tools/workspace';
import { serviceFetch } from '../network/service-network';
import type { Store } from '../storage/store';

type Source = LocalGithubAccount['source'];
type Command = (command: string, args: string[], input?: string) => Promise<string>;
const localCommand: Command = (command, args, input) =>
  new Promise((resolve, reject) => {
    const env = {
      ...minimalEnv(),
      ...(process.platform === 'darwin'
        ? { PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` }
        : {}),
      ...(process.env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR } : {}),
      ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GH_PROMPT_DISABLED: '1',
    };
    // Do not put credentials on argv or propagate stdout/stderr through errors.
    const child = execFile(
      command,
      args,
      {
        cwd: os.homedir(),
        env,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 65536,
      },
      (error, stdout) => (error ? reject(new Error('未能读取本地登录状态')) : resolve(stdout)),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });

export async function readLocalGithubCredential(source: Source, run: Command = localCommand) {
  let token: string;
  if (source === 'git') {
    const output = await run(
      'git',
      ['-c', 'core.askPass=', '-c', 'credential.interactive=false', 'credential', 'fill'],
      'protocol=https\nhost=github.com\n\n',
    );
    const fields = Object.fromEntries(
      output
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    if (fields.protocol !== 'https' || fields.host !== 'github.com')
      throw new Error('本地凭据不属于 GitHub 官方站点');
    token = fields.password ?? '';
  } else token = await run('gh', ['auth', 'token', '--hostname', 'github.com']);
  token = token.trim();
  if (!token || token.length > 10000 || /[\s\x00-\x1f\x7f]/.test(token))
    throw new Error('未检测到可用的 GitHub 凭据');
  return token;
}

export async function verifyLocalGithubIdentity(token: string) {
  try {
    const response = await serviceFetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('invalid');
    const body = (await response.json()) as { id?: number; login?: string };
    if (
      !Number.isSafeInteger(body.id) ||
      !body.id ||
      body.id < 0 ||
      typeof body.login !== 'string' ||
      !/^[\w-]{1,100}$/.test(body.login)
    )
      throw new Error('invalid');
    return { id: String(body.id), login: body.login };
  } catch {
    throw new Error('本地登录未验证通过，请检查网络或重新登录 GitHub');
  }
}
async function catalog(config: PluginConfig, token: string) {
  const connection = new PluginConnection(
    config,
    JSON.stringify({ Authorization: `Bearer ${token}` }),
  );
  try {
    const signal = AbortSignal.timeout(30000);
    await connection.connect(signal);
    return (await connection.tools(signal)).map(pluginTool);
  } catch {
    throw new Error('账号已识别，但 GitHub 插件连接未通过，请检查网络和账号授权后重试');
  } finally {
    await connection.close();
  }
}

/** Detection returns metadata only. Secrets stay in the main process until explicit use. */
export class LocalGithubAccounts {
  private candidates = new Map<
    string,
    { token: string; accountId: string; metadata: LocalGithubAccount }
  >();
  private revision = 0;
  private dependencies: {
    read: typeof readLocalGithubCredential;
    identity: typeof verifyLocalGithubIdentity;
    catalog: typeof catalog;
  };
  constructor(
    private store: Store,
    dependencies: Partial<LocalGithubAccounts['dependencies']> = {},
  ) {
    this.dependencies = {
      read: readLocalGithubCredential,
      identity: verifyLocalGithubIdentity,
      catalog,
      ...dependencies,
    };
  }
  async detect(): Promise<LocalGithubAccount[]> {
    const revision = ++this.revision;
    this.candidates.clear();
    return Promise.all(
      (['git', 'gh'] as const).map(async (source) => {
        const metadata: LocalGithubAccount = { id: randomUUID(), source, status: 'unavailable' };
        let token: string;
        try {
          token = await this.dependencies.read(source);
        } catch {
          return metadata;
        }
        try {
          const account = await this.dependencies.identity(token);
          metadata.status = 'verified';
          metadata.account = account.login;
          metadata.expiresAt = Date.now() + 5 * 60000;
          if (revision === this.revision) {
            this.candidates.set(metadata.id, { token, accountId: account.id, metadata });
            const expiry = setTimeout(() => this.candidates.delete(metadata.id), 5 * 60000);
            expiry.unref();
          }
        } catch {
          metadata.status = 'unverified';
        }
        return metadata;
      }),
    );
  }
  async enable(id: string) {
    const candidate = this.candidates.get(id);
    if (!candidate || (candidate.metadata.expiresAt ?? 0) <= Date.now()) {
      this.candidates.delete(id);
      throw new Error('检测结果已过期，请重新检测本地账号');
    }
    const account = await this.dependencies.identity(candidate.token);
    if (account.id !== candidate.accountId) throw new Error('账号已变更，请重新检测');
    const connectorId = `local-github-${candidate.metadata.source}-${account.id}`;
    const pluginId = `tongzhou-${connectorId}`;
    const plugin: PluginConfig = {
      id: pluginId,
      name: `GitHub · ${account.login}（本地）`,
      transport: 'http',
      command: '',
      args: [],
      url: githubMcpUrl,
      authMode: 'headers',
      enabled: true,
      readOnlyTools: [],
      connectorId,
    };
    const tools: PluginTool[] = await this.dependencies.catalog(plugin, candidate.token);
    if (this.candidates.get(id) !== candidate || (candidate.metadata.expiresAt ?? 0) <= Date.now())
      throw new Error('检测结果已过期，请重新检测本地账号');
    this.store.db.exec('BEGIN');
    try {
      this.store.saveSecret('connector_' + connectorId, candidate.token);
      this.store.put('connector', {
        id: connectorId,
        kind: 'github',
        name: `GitHub · ${account.login}（本地）`,
        baseUrl: 'https://github.com',
        enabled: true,
        status: 'connected',
        account: account.login,
        checkedAt: Date.now(),
        localSource: candidate.metadata.source,
      });
      this.store.put('plugin', { ...plugin, catalog: tools, checkedAt: Date.now() });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.candidates.delete(id);
    return pluginId;
  }
}
