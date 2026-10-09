import { useState } from 'react';
import { Plug, ExternalLink } from 'lucide-react';
import { Modal } from '../../components/components';
import { MarkdownLink } from '../../components/markdown/RichMarkdown';
import { errorMessage } from '../../lib/feedback';
import { LocalGithub } from './LocalGithub';
import { LocalGitlab } from './LocalGitlab';
import type { PluginConfig, PluginInput, Snapshot, TongzhouAPI } from '../../shared/types';
import {
  codeHost,
  codeHostDescription,
  githubMcpUrl,
  gitlabMcpUrl,
} from '../../shared/code-hosting';
export const figmaDesktopUrl = 'http://127.0.0.1:3845/mcp';
export const workPluginCatalog = [
  {
    id: 'github',
    name: 'GitHub 仓库工具',
    category: '代码协作',
    description:
      '支持 Token 和 OAuth2 认证，可检测并复用本机 GitHub 登录。Agent 按需调用官方仓库、Issue、PR 与 Actions 工具。',
    url: githubMcpUrl,
    authMode: 'headers' as const,
    docs: 'https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md',
  },
  {
    id: 'gitlab',
    name: 'GitLab 仓库工具',
    category: '代码协作',
    description:
      '支持 GitLab.com 和自建实例。Token 调用官方 REST API，OAuth2 连接官方 MCP，按账号权限管理项目、Issue、Merge Request 与 CI/CD。',
    url: gitlabMcpUrl,
    authMode: 'headers' as const,
    docs: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
  },
  {
    id: 'figma',
    name: 'Figma',
    category: '设计',
    description: '读取设计上下文、组件与布局，辅助实现界面。',
    url: 'https://mcp.figma.com/mcp',
    authMode: 'oauth' as const,
    docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: '文档',
    description: '搜索和维护授权工作区中的页面与文档。',
    url: 'https://mcp.notion.com/mcp',
    authMode: 'oauth' as const,
    docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
  },
  {
    id: 'linear',
    name: 'Linear',
    category: '项目协作',
    description: '查询和更新任务、项目与进度。',
    url: 'https://mcp.linear.app/mcp',
    authMode: 'oauth' as const,
    docs: 'https://linear.app/docs/mcp',
  },
];
export function workPluginDefinition(plugin: PluginConfig) {
  return plugin.transport === 'http'
    ? workPluginCatalog.find(
        (p) =>
          plugin.url === p.url ||
          p.id === codeHost(plugin) ||
          (p.id === 'figma' && plugin.url === figmaDesktopUrl),
      )
    : undefined;
}
export function OAuthFields({
  edit,
  onChange,
  showAuthentication = true,
}: {
  edit: PluginInput;
  onChange: (p: PluginInput) => void;
  showAuthentication?: boolean;
}) {
  const github = codeHost(edit) === 'github';
  const provider = codeHost(edit);
  const issuer = github
    ? 'https://github.com/login/oauth'
    : edit.url === 'https://mcp.figma.com/mcp'
      ? 'https://api.figma.com'
      : codeHost(edit) === 'gitlab'
        ? new URL(edit.url).origin
        : '';
  return (
    <>
      {showAuthentication && (
        <label>
          认证方式
          <select
            aria-label="认证方式"
            value={edit.authMode ?? 'headers'}
            onChange={(e) =>
              onChange({
                ...edit,
                authMode: e.target.value as 'headers' | 'oauth',
                oauthIssuer: edit.oauthIssuer || (e.target.value === 'oauth' ? issuer : ''),
                secret: '',
                clearSecret: true,
              })
            }
          >
            <option value="headers">{provider ? 'Token 配置' : '访问令牌 / 请求头'}</option>
            <option value="oauth">{provider ? 'OAuth2 授权' : '浏览器 OAuth 授权'}</option>
          </select>
        </label>
      )}
      {edit.authMode === 'oauth' && !github && (
        <details>
          <summary>高级：使用已注册的 OAuth 应用</summary>
          <div className="oauth-app-fields">
            <label>
              预注册 Client ID（可选）
              <input
                value={edit.oauthClientId ?? ''}
                onChange={(e) =>
                  onChange({
                    ...edit,
                    oauthClientId: e.target.value,
                    oauthIssuer: edit.oauthIssuer || issuer,
                  })
                }
              />
            </label>
            <label>
              Client Secret（留空保留）
              <input
                type="password"
                autoComplete="new-password"
                value={edit.oauthClientSecret ?? ''}
                onChange={(e) => onChange({ ...edit, oauthClientSecret: e.target.value })}
              />
            </label>
            {edit.hasOAuthClientSecret && <small>应用密钥已加密保存。</small>}
            {edit.hasOAuthClientSecret && (
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={!!edit.clearOAuthClientSecret}
                  onChange={(e) => onChange({ ...edit, clearOAuthClientSecret: e.target.checked })}
                />
                清除已保存的应用密钥
              </label>
            )}
            <label>
              对应授权服务地址（Issuer）
              <input
                type="url"
                placeholder="https://..."
                value={edit.oauthIssuer ?? ''}
                onChange={(e) => onChange({ ...edit, oauthIssuer: e.target.value })}
              />
            </label>
            <p>
              服务允许动态注册时可留空；需要预注册时使用回调地址：
              http://127.0.0.1:17438/mcp/callback。具体可用权限由服务账号决定。
            </p>
          </div>
        </details>
      )}
    </>
  );
}
export function PluginAuthStatus({ plugin }: { plugin?: PluginConfig }) {
  return (
    <div>
      <span
        className={
          'status-pill ' +
          (plugin?.oauthStatus === 'authorized'
            ? 'completed'
            : plugin?.oauthStatus === 'error'
              ? 'failed'
              : '')
        }
      >
        {
          {
            authorized: '✓ 已授权',
            starting: '正在连接授权服务',
            waiting: '等待浏览器授权',
            error: '授权未完成',
            cancelled: '已取消',
            none: '尚未授权',
          }[plugin?.oauthStatus ?? 'none']
        }
      </span>
      {plugin?.oauthStatus === 'authorized' && plugin.oauthAccount && (
        <small>GitHub · {plugin.oauthAccount}</small>
      )}
      {plugin?.oauthError && (
        <p role="alert" className="info-strip">
          {plugin.oauthError}
        </p>
      )}
    </div>
  );
}

function PluginToolList({ plugin }: { plugin: PluginConfig }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const tools = (plugin.catalog ?? []).filter((t) =>
    (t.name + ' ' + t.description).toLowerCase().includes(query.toLowerCase()),
  );
  const last = Math.max(0, Math.ceil(tools.length / 20) - 1);
  const current = Math.min(page, last);
  return (
    <details>
      <summary>{plugin.catalog?.length ?? 0} 个已发现工具 · Agent 按需搜索调用</summary>
      <input
        aria-label={`${plugin.name} 工具搜索`}
        placeholder="搜索工具名称或用途"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(0);
        }}
      />
      <div className="plugin-tool-list">
        {tools.slice(current * 20, (current + 1) * 20).map((t) => (
          <p key={t.name}>
            <strong>{t.name}</strong>
            <span>{t.description.slice(0, 180)}</span>
          </p>
        ))}
        {!tools.length && <p>没有匹配的工具</p>}
      </div>
      {tools.length > 20 && (
        <div className="row">
          <button disabled={current === 0} onClick={() => setPage(current - 1)}>
            上一页
          </button>
          <span>
            {current + 1} / {last + 1}
          </span>
          <button disabled={current === last} onClick={() => setPage(current + 1)}>
            下一页
          </button>
        </div>
      )}
    </details>
  );
}
export function WorkPlugins({
  data,
  api,
  refresh,
  query,
  onManage,
}: {
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  query: string;
  onManage: (plugin: PluginConfig) => void;
}) {
  const [selectedConnections, setSelectedConnections] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<PluginInput | null>(null),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [source, setSource] = useState('');
  const [editingService, setEditingService] = useState('');
  const tokenMode = edit?.authMode === 'oauth' ? 'oauth' : source ? 'saved' : 'token';
  const tokenProvider = edit ? codeHost(edit) : undefined;
  const tokenSite =
    tokenProvider === 'github' ? 'https://github.com' : edit?.url.replace(/\/api\/v4\/mcp\/?$/, '');
  const tokenAccounts = (data.connectors ?? []).filter(
    (c) =>
      c.kind === tokenProvider &&
      c.enabled &&
      c.hasSecret &&
      c.baseUrl.replace(/\/$/, '') === tokenSite,
  );
  const [loginUrl, setLoginUrl] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const act = async (fn: () => Promise<unknown>, success = '已保存') => {
    setBusy(true);
    setNotice('');
    try {
      const result = await fn();
      await refresh();
      setNotice(typeof result === 'string' ? result : success);
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const current = edit ? data.plugins?.find((p) => p.id === edit.id) : undefined;
  const authCurrent =
    current &&
    edit &&
    current.url === edit.url &&
    current.authMode === edit.authMode &&
    (codeHost(edit) === 'github' ||
      (current.oauthClientId === edit.oauthClientId && current.oauthIssuer === edit.oauthIssuer))
      ? current
      : undefined;
  const configureLocalGitlab = (plugin: PluginConfig) => {
    setSelectedConnections((old) => ({ ...old, gitlab: plugin.id }));
    setEditingService('gitlab');
    setLoginUrl('');
    setLoginCode('');
    setToken('');
    setSource(plugin.connectorId ?? '');
    setNotice('本地账号已保存。可点击「保存并检查」验证 Token 工具连接，再启用插件。');
    setEdit({ ...plugin, secret: '' });
  };
  const save = async () => {
    if (!edit) return;
    if (editingService === 'gitlab' && codeHost(edit) !== 'gitlab')
      throw new Error('请输入有效的 GitLab HTTPS 实例地址');
    if (codeHost(edit) && tokenMode === 'token' && current?.connectorId && !token)
      throw new Error('从本地账号切换为手动 Token 时，请输入访问令牌，或继续复用原 Token 来源。');
    if (codeHost(edit) && tokenMode === 'saved' && !tokenAccounts.some((c) => c.id === source))
      throw new Error('请选择已保存的账号，或手动配置 Token。');
    await api.savePlugin({
      ...edit,
      connectorId: codeHost(edit) && tokenMode === 'saved' ? source : undefined,
      secret: token.trim()
        ? JSON.stringify({ Authorization: 'Bearer ' + token.trim() })
        : undefined,
    });
    setEdit((old) =>
      old?.id === edit.id
        ? {
            ...old,
            clearSecret: false,
            secret: undefined,
            oauthClientSecret: '',
            clearOAuthClientSecret: false,
          }
        : old,
    );
    setToken('');
    await refresh();
  };
  return (
    <section className="work-plugins">
      {notice && !edit && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      <div className="provider-grid">
        {workPluginCatalog
          .filter((p) =>
            (p.name + p.category + p.description).toLowerCase().includes(query.toLowerCase()),
          )
          .map((p) => {
            const connections = (data.plugins ?? []).filter(
              (c) => workPluginDefinition(c)?.id === p.id,
            );
            const installed =
              connections.find((c) => c.id === selectedConnections[p.id]) ?? connections[0];
            return (
              <article className="provider-card" key={p.id}>
                <div className="service-card-heading row">
                  <Plug size={20} />
                  <h3>{p.name}</h3>
                  <span className="tag">应用 · {p.category}</span>
                </div>
                <p>{p.description}</p>
                {connections.length > 1 && (
                  <select
                    aria-label={`${p.name} 连接`}
                    value={installed.id}
                    onChange={(e) =>
                      setSelectedConnections((old) => ({ ...old, [p.id]: e.target.value }))
                    }
                  >
                    {connections.map((connection, index) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name} · {index + 1}
                        {connection.url === figmaDesktopUrl ? ' · 桌面' : ''}
                      </option>
                    ))}
                  </select>
                )}
                <div className="row">
                  <span className="muted">
                    {installed
                      ? installed.oauthStatus === 'error'
                        ? '授权未完成'
                        : installed.oauthStatus === 'starting'
                          ? '正在连接授权服务'
                          : installed.oauthStatus === 'waiting'
                            ? '等待浏览器授权'
                            : installed.url === figmaDesktopUrl
                              ? installed.catalog
                                ? '✓ 已连接'
                                : '待连接桌面服务'
                              : installed.oauthStatus === 'authorized'
                                ? '✓ 已授权'
                                : installed.hasSecret
                                  ? installed.checkedAt
                                    ? '✓ 连接已验证'
                                    : '凭据已保存 · 待检查'
                                  : '待认证'
                      : '未配置'}
                    {installed ? ' · ' + (installed.enabled ? '已启用' : '已停用') : ''}
                  </span>
                  <a
                    href={p.docs}
                    onClick={(e) => {
                      e.preventDefault();
                      void api
                        .openExternalLink(p.docs)
                        .catch((error) => setNotice(errorMessage(error)));
                    }}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${p.name} 官方说明`}
                    title="官方说明"
                  >
                    <ExternalLink size={13} />
                  </a>
                </div>
                <div className="row service-card-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setNotice('');
                      setLoginUrl('');
                      setLoginCode('');
                      setEditingService(p.id);
                      setEdit(
                        installed
                          ? {
                              ...installed,
                              secret: '',
                              authMode: installed.authMode ?? p.authMode,
                            }
                          : {
                              id: crypto.randomUUID(),
                              name: p.name,
                              transport: 'http',
                              url: p.url,
                              command: '',
                              args: [],
                              enabled: false,
                              readOnlyTools: [],
                              authMode: p.authMode,
                            },
                      );
                      setToken('');
                      setSource(
                        ['github', 'gitlab'].includes(p.id) && installed?.authMode !== 'oauth'
                          ? (installed?.connectorId ?? '')
                          : '',
                      );
                    }}
                  >
                    {installed ? '管理连接' : '配置插件'}
                  </button>
                </div>
                {installed?.catalog && <PluginToolList plugin={installed} />}
                {p.id === 'github' && <LocalGithub api={api} refresh={refresh} />}
                {p.id === 'gitlab' && (
                  <LocalGitlab
                    key={installed?.url ?? 'gitlab'}
                    api={api}
                    refresh={refresh}
                    instance={installed?.url.replace(/\/api\/v4\/mcp\/?$/, '')}
                    instances={(data.connectors ?? [])
                      .filter((c) => c.kind === 'gitlab')
                      .map((c) => c.baseUrl)}
                    onConfigure={configureLocalGitlab}
                  />
                )}
              </article>
            );
          })}
      </div>
      {edit && (
        <Modal title={`连接 ${edit.name}`} onClose={() => setEdit(null)}>
          <form
            className="modal-content connection-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await save();
                setEdit(null);
              });
            }}
          >
            {notice && notice !== current?.oauthError && (
              <p role="status" className="info-strip">
                {notice}
              </p>
            )}
            {editingService === 'gitlab' && (
              <>
                <label>
                  GitLab 实例地址
                  <input
                    aria-label="GitLab 实例地址"
                    type="url"
                    required
                    value={edit.url.replace(/\/api\/v4\/mcp\/?$/, '')}
                    placeholder="https://gitlab.com"
                    onChange={(e) => {
                      setSource('');
                      setToken('');
                      setLoginUrl('');
                      setLoginCode('');
                      setNotice('');
                      setEdit({
                        ...edit,
                        url: e.target.value.replace(/\/$/, '') + '/api/v4/mcp',
                        authMode: edit.authMode ?? 'headers',
                        oauthClientId: '',
                        oauthIssuer: '',
                        oauthClientSecret: '',
                        clearSecret: true,
                      });
                    }}
                  />
                </label>
                {edit.authMode !== 'oauth' && (
                  <LocalGitlab
                    key={edit.url}
                    api={api}
                    refresh={refresh}
                    instance={edit.url.replace(/\/api\/v4\/mcp\/?$/, '')}
                    showInstanceInput={false}
                    onConfigure={configureLocalGitlab}
                  />
                )}
                {(data.connectors ?? []).some((c) => c.kind === 'gitlab') && (
                  <label>
                    使用已有 GitLab 站点
                    <select
                      aria-label="使用已有 GitLab 站点"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) {
                          setSource('');
                          setToken('');
                          setLoginUrl('');
                          setLoginCode('');
                          setNotice('');
                          setEdit({
                            ...edit,
                            url: e.target.value.replace(/\/$/, '') + '/api/v4/mcp',
                            authMode: edit.authMode ?? 'headers',
                            oauthClientId: '',
                            oauthIssuer: '',
                            oauthClientSecret: '',
                            clearSecret: true,
                          });
                        }
                      }}
                    >
                      <option value="">选择站点（仍需独立授权）</option>
                      {(data.connectors ?? [])
                        .filter((c) => c.kind === 'gitlab')
                        .map((c) => (
                          <option key={c.id} value={c.baseUrl}>
                            {c.name} · {c.baseUrl}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <p>
                  {edit.authMode === 'oauth'
                    ? 'OAuth2 使用 GitLab 官方 MCP 授权，需实例支持并启用 MCP；支持自动注册或预注册 OAuth 应用。'
                    : 'Token 使用此实例的官方 REST API，无需实例启用 MCP。保存并检查会验证 Token 身份和 API 连接。'}
                </p>
              </>
            )}
            {codeHost(edit) && (
              <p>
                {codeHostDescription(codeHost(edit)!)}{' '}
                工具将在会话中按需发现，也可点击「保存并检查」预览完整目录。
              </p>
            )}
            {(edit.url === 'https://mcp.figma.com/mcp' || edit.url === figmaDesktopUrl) && (
              <>
                <label>
                  Figma 连接方式
                  <select
                    aria-label="Figma 连接方式"
                    value={edit.url}
                    onChange={(e) => {
                      setEdit({
                        ...edit,
                        url: e.target.value,
                        authMode: e.target.value === figmaDesktopUrl ? 'headers' : 'oauth',
                        clearSecret: true,
                        oauthClientId: '',
                        oauthIssuer: '',
                        oauthClientSecret: '',
                      });
                      setToken('');
                      setLoginUrl('');
                      setLoginCode('');
                      setNotice('');
                    }}
                  >
                    <option value="https://mcp.figma.com/mcp">远程服务 · 浏览器授权</option>
                    <option value={figmaDesktopUrl}>桌面服务 · 本机连接</option>
                  </select>
                </label>
                <p>
                  {edit.url === figmaDesktopUrl
                    ? '在 Figma 桌面应用打开文件，进入 Dev Mode 并启用 MCP Server，然后点击「保存并检查」。无需在同舟登录。'
                    : 'Figma 远程 MCP 要求服务方认可的客户端。注册被拒绝时可配置已获准的 OAuth 应用，或选择桌面服务。'}
                </p>
              </>
            )}
            {codeHost(edit) && (
              <label>
                认证方式
                <select
                  aria-label="认证方式"
                  value={edit.authMode === 'oauth' ? 'oauth' : 'headers'}
                  disabled={busy}
                  onChange={(e) => {
                    const mode = e.target.value as 'headers' | 'oauth';
                    setToken('');
                    setSource('');
                    setLoginUrl('');
                    setLoginCode('');
                    setNotice('');
                    setEdit({
                      ...edit,
                      authMode: mode,
                      clearSecret: true,
                      oauthClientSecret: '',
                      oauthClientId: current?.authMode === mode ? current.oauthClientId : '',
                      oauthIssuer:
                        mode === 'oauth'
                          ? codeHost(edit) === 'github'
                            ? 'https://github.com/login/oauth'
                            : new URL(edit.url).origin
                          : '',
                    });
                  }}
                >
                  <option value="headers">Token 配置</option>
                  <option value="oauth">OAuth2 授权</option>
                </select>
              </label>
            )}
            {codeHost(edit) && edit.authMode !== 'oauth' && tokenAccounts.length > 0 && (
              <label>
                Token 来源
                <select
                  aria-label="Token 来源"
                  value={source}
                  disabled={busy}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setToken('');
                    setEdit({ ...edit, clearSecret: false });
                  }}
                >
                  <option value="">手动配置 Token</option>
                  {tokenAccounts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <small>可复用本地检测保存的 Token；调用时仍会检查账号和连接权限。</small>
              </label>
            )}
            {edit.url !== figmaDesktopUrl && (
              <OAuthFields edit={edit} onChange={setEdit} showAuthentication={!codeHost(edit)} />
            )}
            {edit.authMode !== 'oauth' && edit.url !== figmaDesktopUrl && !source && (
              <label>
                访问令牌（留空保留）
                <input
                  aria-label="访问令牌（留空保留）"
                  type="password"
                  autoComplete="new-password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                {codeHost(edit) && (
                  <small>
                    {codeHost(edit) === 'github'
                      ? '使用 GitHub Personal Access Token，按目标仓库授予权限；保存并检查后确认官方 MCP 连接。'
                      : '使用 GitLab Personal / Project / Group Access Token；读取通常需要 read_api，写操作需要 api，并受项目权限限制。'}
                  </small>
                )}
              </label>
            )}
            {edit.authMode === 'oauth' && (
              <div className="plugin-auth-controls">
                <PluginAuthStatus plugin={authCurrent} />
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    busy || ['starting', 'waiting'].includes(authCurrent?.oauthStatus ?? '')
                  }
                  onClick={() =>
                    void act(async () => {
                      await save();
                      const result = await api.loginPlugin(edit.id);
                      setLoginUrl(result.url ?? '');
                      setLoginCode(result.code ?? '');
                      return result.url
                        ? result.browserOpened
                          ? '已打开浏览器，请完成授权。'
                          : '系统浏览器未打开，请点击「打开授权页面」继续。'
                        : '授权已更新。';
                    }, '授权状态已更新，请在下方查看。')
                  }
                >
                  {codeHost(edit) === 'github' ? '使用 GitHub 登录' : '浏览器授权'}
                </button>
                {loginCode && authCurrent?.oauthStatus === 'waiting' && (
                  <p className="info-strip">
                    在 GitHub 授权页面输入验证码：<strong>{loginCode}</strong>
                  </p>
                )}
                {loginUrl && authCurrent?.oauthStatus === 'waiting' && (
                  <MarkdownLink href={loginUrl}>打开授权页面</MarkdownLink>
                )}
                {['starting', 'waiting'].includes(authCurrent?.oauthStatus ?? '') && (
                  <button
                    type="button"
                    onClick={() => void act(() => api.cancelPluginLogin(edit.id), '已取消授权')}
                  >
                    取消授权
                  </button>
                )}
                {authCurrent?.oauthStatus === 'authorized' && (
                  <button
                    type="button"
                    onClick={() => void act(() => api.logoutPlugin(edit.id), '已清除本地授权')}
                  >
                    退出授权
                  </button>
                )}
              </div>
            )}
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
              />
              在会话中启用此插件
            </label>
            <p>凭据使用系统加密保存。工具能访问的范围取决于服务端授权，执行遵循同舟会话权限。</p>
            <div className="row">
              <button className="primary" disabled={busy}>
                保存连接
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await save();
                    await api.testPlugin(edit.id);
                  }, '✓ 插件连接检查通过')
                }
              >
                保存并检查
              </button>
              {current && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await save();
                      const saved = (await api.snapshot()).plugins?.find(
                        (p) => p.id === current.id,
                      );
                      if (!saved) throw new Error('连接已删除，请刷新后重试');
                      setEdit(null);
                      onManage(saved);
                    })
                  }
                >
                  高级 MCP 设置
                </button>
              )}
            </div>
            {current && (
              <details>
                <summary>其他账号与站点</summary>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    const p = workPluginCatalog.find((p) => p.id === editingService);
                    if (!p) return;
                    setNotice('');
                    setLoginUrl('');
                    setLoginCode('');
                    setToken('');
                    setSource('');
                    setEdit({
                      id: crypto.randomUUID(),
                      name: p.name,
                      transport: 'http',
                      url: p.url,
                      command: '',
                      args: [],
                      enabled: false,
                      readOnlyTools: [],
                      authMode: p.authMode,
                    });
                  }}
                >
                  添加其他账号或站点
                </button>
              </details>
            )}
          </form>
        </Modal>
      )}
    </section>
  );
}
