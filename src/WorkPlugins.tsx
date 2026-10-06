import { useState } from 'react';
import { Search, Plug, Plus, ExternalLink } from 'lucide-react';
import { Modal } from './components';
import { MarkdownLink } from './RichMarkdown';
import { errorMessage } from './feedback';
import type { PluginConfig, PluginInput, Snapshot, TongzhouAPI } from './shared/types';
import { codeHost, codeHostDescription, githubMcpUrl, gitlabMcpUrl } from './shared/code-hosting';
export const figmaDesktopUrl = 'http://127.0.0.1:3845/mcp';
export const workPluginCatalog = [
  {
    id: 'github',
    name: 'GitHub 仓库工具',
    category: '代码协作',
    description:
      '完整官方工具集：仓库、Issue、PR、Actions、日志、构建产物、发布与项目。可绑定已有 GitHub 账号，Agent 按需发现和调用。',
    url: githubMcpUrl,
    authMode: 'headers' as const,
    docs: 'https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md',
  },
  {
    id: 'gitlab',
    name: 'GitLab 仓库工具',
    category: '代码协作',
    description:
      '完整官方工具集：项目、Issue、Merge Request、CI/CD、Wiki 与安全工具。支持 GitLab.com 和自建实例，使用浏览器授权。',
    url: gitlabMcpUrl,
    authMode: 'oauth' as const,
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
}: {
  edit: PluginInput;
  onChange: (p: PluginInput) => void;
}) {
  const github = codeHost(edit) === 'github';
  const gitlab = codeHost(edit) === 'gitlab';
  const issuer = github
    ? 'https://github.com/login/oauth'
    : edit.url === 'https://mcp.figma.com/mcp'
      ? 'https://api.figma.com'
      : codeHost(edit) === 'gitlab'
        ? new URL(edit.url).origin
        : '';
  return (
    <>
      {!gitlab && (
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
            <option value="headers">访问令牌 / 请求头</option>
            <option value="oauth">浏览器 OAuth 授权</option>
          </select>
        </label>
      )}
      {edit.authMode === 'oauth' && (
        <details>
          <summary>
            {github ? '高级：自定义 GitHub OAuth 应用' : '高级：使用已注册的 OAuth 应用'}
          </summary>
          <div className="oauth-app-fields">
            <label>
              {github ? 'OAuth App Client ID（必填）' : '预注册 Client ID（可选）'}
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
              {github
                ? 'GitHub 不支持自动注册应用。填写自己的 OAuth App 信息，或切换到访问令牌 / 已保存账号。应用回调地址：'
                : '服务允许动态注册时可留空；需要预注册时使用回调地址：'}
              http://127.0.0.1:17438/mcp/callback。具体可用权限由服务账号决定。
            </p>
            {github && (
              <MarkdownLink href="https://github.com/settings/developers">
                管理 GitHub OAuth 应用
              </MarkdownLink>
            )}
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
  onCustom,
  onManage,
}: {
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  onCustom: () => void;
  onManage: (plugin: PluginConfig) => void;
}) {
  const [selectedConnections, setSelectedConnections] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(''),
    [edit, setEdit] = useState<PluginInput | null>(null),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [source, setSource] = useState('');
  const [editingService, setEditingService] = useState('');
  const [githubMode, setGithubMode] = useState<'saved' | 'token' | 'oauth'>('token');
  const githubAccounts = (data.connectors ?? []).filter(
    (c) =>
      c.kind === 'github' &&
      c.enabled &&
      c.hasSecret &&
      c.baseUrl.replace(/\/$/, '') === 'https://github.com',
  );
  const [loginUrl, setLoginUrl] = useState('');
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
  const save = async () => {
    if (!edit) return;
    if (editingService === 'gitlab' && codeHost(edit) !== 'gitlab')
      throw new Error('请输入有效的 GitLab HTTPS 实例地址');
    if (codeHost(edit) === 'github' && githubMode === 'token' && current?.connectorId && !token)
      throw new Error(
        '从已绑定账号切换为独立令牌时，请输入访问令牌；继续使用账号请选择「已保存的 GitHub 账号」。',
      );
    if (
      edit.url === workPluginCatalog[0].url &&
      githubMode === 'saved' &&
      !githubAccounts.some((c) => c.id === source)
    )
      throw new Error('请选择已保存的 GitHub 账号，或切换到访问令牌。');
    await api.savePlugin({
      ...edit,
      connectorId: codeHost(edit) === 'github' && githubMode === 'saved' ? source : undefined,
      secret: token ? JSON.stringify({ Authorization: 'Bearer ' + token }) : undefined,
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
      <div className="collection-toolbar">
        <div>
          <h2>工作插件</h2>
          <p>
            连接后，各个 Agent
            引擎共享工具目录，按需搜索和调用。账号授权与会话权限共同决定可执行的操作。
          </p>
        </div>
        <div className="search-box">
          <Search size={14} />
          <input
            aria-label="搜索工作插件"
            placeholder="搜索服务或用途"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
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
                                  ? '凭据已保存'
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
                      setEditingService(p.id);
                      const mode = installed?.connectorId
                        ? 'saved'
                        : installed?.authMode === 'oauth' && installed.oauthClientId
                          ? 'oauth'
                          : installed?.hasSecret
                            ? 'token'
                            : githubAccounts.length
                              ? 'saved'
                              : 'token';
                      setGithubMode(mode);
                      setEdit(
                        installed
                          ? {
                              ...installed,
                              secret: '',
                              ...(p.id === 'github'
                                ? { authMode: mode === 'oauth' ? 'oauth' : 'headers' }
                                : {}),
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
                        p.id === 'github' && mode === 'saved'
                          ? (installed?.connectorId ?? githubAccounts[0]?.id ?? '')
                          : '',
                      );
                    }}
                  >
                    {installed ? '管理连接' : '配置插件'}
                  </button>
                  {installed && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            api.savePlugin({ ...installed, enabled: !installed.enabled }),
                          )
                        }
                      >
                        {installed.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const tools = await api.testPlugin(installed.id);
                            return `✓ ${p.name} 连接成功，共 ${tools.length} 个工具`;
                          }, '连接检查已完成')
                        }
                      >
                        检查工具
                      </button>
                    </>
                  )}
                </div>
                {installed?.catalog && <PluginToolList plugin={installed} />}
              </article>
            );
          })}
      </div>
      <button className="text-button" onClick={onCustom}>
        <Plus size={14} />
        前往内置与自定义
      </button>
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
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        url: e.target.value.replace(/\/$/, '') + '/api/v4/mcp',
                        authMode: 'oauth',
                        oauthClientId: '',
                        oauthIssuer: '',
                        oauthClientSecret: '',
                        clearSecret: true,
                      })
                    }
                  />
                </label>
                {(data.connectors ?? []).some((c) => c.kind === 'gitlab') && (
                  <label>
                    使用已有 GitLab 站点
                    <select
                      aria-label="使用已有 GitLab 站点"
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          setEdit({
                            ...edit,
                            url: e.target.value.replace(/\/$/, '') + '/api/v4/mcp',
                            authMode: 'oauth',
                            oauthClientId: '',
                            oauthIssuer: '',
                            oauthClientSecret: '',
                            clearSecret: true,
                          });
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
                  GitLab 官方 MCP 使用浏览器 OAuth 授权。请先在 GitLab 群组或自建实例中开启 MCP
                  访问；工具范围取决于实例版本和账号权限。已有 Git 令牌不会自动用于 MCP。
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
            {edit.url === workPluginCatalog[0].url && (
              <>
                <p>保存或复用 GitHub 认证，供会话中的仓库工具使用。</p>
                {current?.hasSecret && edit.authMode !== 'oauth' && (
                  <span className="status-pill">✓ 凭据已保存</span>
                )}
                <label>
                  认证来源
                  <select
                    aria-label="认证来源"
                    value={githubMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'saved' | 'token' | 'oauth';
                      setGithubMode(mode);
                      setToken('');
                      setLoginUrl('');
                      setNotice('');
                      setSource(mode === 'saved' ? (githubAccounts[0]?.id ?? '') : '');
                      setEdit({
                        ...edit,
                        authMode: mode === 'oauth' ? 'oauth' : 'headers',
                        oauthIssuer:
                          mode === 'oauth'
                            ? edit.oauthIssuer || 'https://github.com/login/oauth'
                            : current?.oauthIssuer,
                        oauthClientId:
                          mode === 'oauth' ? edit.oauthClientId : current?.oauthClientId,
                      });
                    }}
                  >
                    <option value="saved">已保存的 GitHub 账号</option>
                    <option value="token">访问令牌</option>
                    <option value="oauth">自定义 OAuth 应用（高级）</option>
                  </select>
                </label>
                {githubMode === 'saved' && (
                  <>
                    <label>
                      GitHub 账号
                      <select
                        aria-label="GitHub 账号"
                        value={source}
                        onChange={(e) => setSource(e.target.value)}
                      >
                        <option value="">选择已保存的账号</option>
                        {githubAccounts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p>
                      {githubAccounts.length
                        ? '插件直接绑定此账号，无需重复输入。账号更新认证后自动使用新凭据；移除或停用账号后停止调用。'
                        : '还没有可用的 GitHub 账号。可在连接中心添加，或选择访问令牌。'}
                    </p>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setEdit(null);
                        void api.openModule('connections');
                      }}
                    >
                      到连接中心管理账号
                    </button>
                  </>
                )}
                {githubMode === 'oauth' && (
                  <p>仅供自行注册 OAuth 应用的开发者使用。普通使用请选择已保存账号或访问令牌。</p>
                )}
              </>
            )}
            {edit.url !== figmaDesktopUrl &&
              (edit.url !== workPluginCatalog[0].url || githubMode === 'oauth') && (
                <OAuthFields
                  edit={edit}
                  onChange={(next) => {
                    setEdit(next);
                    if (edit.url === workPluginCatalog[0].url && next.authMode !== 'oauth')
                      setGithubMode('token');
                  }}
                />
              )}
            {edit.authMode !== 'oauth' &&
              edit.url !== figmaDesktopUrl &&
              (edit.url !== workPluginCatalog[0].url || githubMode === 'token') && (
                <label>
                  访问令牌（留空保留）
                  <input
                    aria-label="访问令牌（留空保留）"
                    type="password"
                    autoComplete="new-password"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setSource('');
                    }}
                  />
                  {edit.url === workPluginCatalog[0].url && (
                    <small>令牌加密保存在本机。请按需授予仓库权限，保存后可检查工具连接。</small>
                  )}
                </label>
              )}
            {edit.authMode === 'oauth' && (
              <div className="plugin-auth-controls">
                <PluginAuthStatus plugin={current} />
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || ['starting', 'waiting'].includes(current?.oauthStatus ?? '')}
                  onClick={() =>
                    void act(async () => {
                      await save();
                      const result = await api.loginPlugin(edit.id);
                      setLoginUrl(result.url ?? '');
                      return result.url
                        ? result.browserOpened
                          ? '已打开浏览器，请完成授权。'
                          : '系统浏览器未打开，请点击「打开授权页面」继续。'
                        : '授权已更新。';
                    }, '授权状态已更新，请在下方查看。')
                  }
                >
                  浏览器授权
                </button>
                {loginUrl && current?.oauthStatus === 'waiting' && (
                  <MarkdownLink href={loginUrl}>打开授权页面</MarkdownLink>
                )}
                {['starting', 'waiting'].includes(current?.oauthStatus ?? '') && (
                  <button
                    type="button"
                    onClick={() => void act(() => api.cancelPluginLogin(edit.id), '已取消授权')}
                  >
                    取消授权
                  </button>
                )}
                {current?.oauthStatus === 'authorized' && (
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
                    setToken('');
                    setGithubMode(githubAccounts.length ? 'saved' : 'token');
                    setSource(p.id === 'github' ? (githubAccounts[0]?.id ?? '') : '');
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
