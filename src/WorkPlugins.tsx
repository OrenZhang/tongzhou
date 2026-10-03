import { useState } from 'react';
import { Search, Plug, Plus, ExternalLink } from 'lucide-react';
import { Modal } from './components';
import { errorMessage } from './feedback';
import type { PluginConfig, PluginInput, Snapshot, TongzhouAPI } from './shared/types';
export const figmaDesktopUrl = 'http://127.0.0.1:3845/mcp';
export const workPluginCatalog = [
  {
    id: 'github',
    name: 'GitHub 仓库工具',
    category: '可选 MCP',
    description:
      '在会话中搜索仓库、查看代码、处理 Issue 和 Pull Request。可复用连接中心的 GitHub 账号。',
    url: 'https://api.githubcopilot.com/mcp/',
    authMode: 'headers' as const,
    docs: 'https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md',
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
export function OAuthFields({
  edit,
  onChange,
}: {
  edit: PluginInput;
  onChange: (p: PluginInput) => void;
}) {
  const github = edit.url === workPluginCatalog[0].url;
  const issuer = github
    ? 'https://github.com/login/oauth'
    : edit.url === 'https://mcp.figma.com/mcp'
      ? 'https://api.figma.com'
      : '';
  return (
    <>
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
      {edit.authMode === 'oauth' && (
        <details open={github || undefined}>
          <summary>{github ? 'GitHub OAuth 应用（必填）' : '使用已注册的 OAuth 应用'}</summary>
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
              <a href="https://github.com/settings/developers" target="_blank" rel="noreferrer">
                管理 GitHub OAuth 应用
              </a>
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
export function WorkPlugins({
  data,
  api,
  refresh,
  onCustom,
}: {
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  onCustom: () => void;
}) {
  const [query, setQuery] = useState(''),
    [edit, setEdit] = useState<PluginInput | null>(null),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [source, setSource] = useState('');
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
    await api.savePlugin({
      ...edit,
      secret: token ? JSON.stringify({ Authorization: 'Bearer ' + token }) : undefined,
    });
    if (source && edit.authMode !== 'oauth' && edit.url === workPluginCatalog[0].url)
      await api.useGithubConnector(edit.id, source);
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
    setSource('');
    await refresh();
  };
  return (
    <section className="work-plugins">
      <div className="collection-toolbar">
        <div>
          <h2>工作插件</h2>
          <p>按需添加设计、文档与协作工具，启用后可在会话中调用。</p>
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
            const installed = data.plugins?.find(
              (c) =>
                c.transport === 'http' &&
                (c.url === p.url || (p.id === 'figma' && c.url === figmaDesktopUrl)),
            );
            return (
              <article className="provider-card" key={p.id}>
                <div className="service-card-heading row">
                  <Plug size={20} />
                  <h3>{p.name}</h3>
                  <span className="tag">{p.category}</span>
                </div>
                <p>{p.description}</p>
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
                      setEdit(
                        installed
                          ? { ...installed, secret: '' }
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
                      setSource('');
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
                {installed?.catalog && (
                  <details>
                    <summary>{installed.catalog.length} 个可用工具</summary>
                    <div className="plugin-tool-list">
                      {installed.catalog.map((t) => (
                        <p key={t.name}>
                          <strong>{t.name}</strong>
                          <span>{t.description.slice(0, 180)}</span>
                        </p>
                      ))}
                    </div>
                  </details>
                )}
              </article>
            );
          })}
      </div>
      <button className="text-button" onClick={onCustom}>
        <Plus size={14} />
        配置其他 MCP 服务或本机插件
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
            <p>{edit.url}</p>
            {edit.url !== figmaDesktopUrl && <OAuthFields edit={edit} onChange={setEdit} />}
            {edit.authMode !== 'oauth' && edit.url !== figmaDesktopUrl && (
              <>
                <label>
                  访问令牌（留空保留）
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setSource('');
                    }}
                  />
                </label>
                {edit.url === workPluginCatalog[0].url && (
                  <label>
                    或使用已保存的 GitHub 账号
                    <select
                      value={source}
                      onChange={(e) => {
                        setSource(e.target.value);
                        setToken('');
                      }}
                    >
                      <option value="">单独配置此插件凭据</option>
                      {(data.connectors ?? [])
                        .filter(
                          (c) =>
                            c.kind === 'github' &&
                            c.enabled &&
                            c.hasSecret &&
                            c.baseUrl.replace(/\/$/, '') === 'https://github.com',
                        )
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </>
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
                  <a href={loginUrl} target="_blank" rel="noreferrer">
                    打开授权页面
                  </a>
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
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
