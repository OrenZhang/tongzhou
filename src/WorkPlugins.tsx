import { useState } from 'react';
import { Search, Plug, Plus, ExternalLink } from 'lucide-react';
import { Modal } from './components';
import type { PluginInput, Snapshot, TongzhouAPI } from './shared/types';
export const workPluginCatalog = [
  {
    id: 'github',
    name: 'GitHub 仓库工具',
    category: '可选 MCP',
    description: '在会话中搜索仓库、查看代码、处理 Issue 和 Pull Request。可复用上方 GitHub 账号。',
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
        <details>
          <summary>高级 OAuth 设置</summary>
          <div className="connection-form">
            <label>
              预注册 Client ID（可选）
              <input
                value={edit.oauthClientId ?? ''}
                onChange={(e) => onChange({ ...edit, oauthClientId: e.target.value })}
              />
            </label>
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
              支持动态注册的服务可留空。需要自行注册时使用回调地址
              http://127.0.0.1:17438/mcp/callback。具体可用权限由服务账号决定。
            </p>
          </div>
        </details>
      )}
    </>
  );
}
export function WorkPlugins({
  data,
  api,
  refresh,
}: {
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState(''),
    [edit, setEdit] = useState<PluginInput | null>(null),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [source, setSource] = useState('');
  const act = async (fn: () => Promise<unknown>, success = '已保存') => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      await refresh();
      setNotice(success);
    } catch (e) {
      setNotice(String(e));
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
    if (source && edit.url === workPluginCatalog[0].url)
      await api.useGithubConnector(edit.id, source);
    setEdit((old) =>
      old?.id === edit.id ? { ...old, clearSecret: false, secret: undefined } : old,
    );
    setToken('');
    setSource('');
    await refresh();
  };
  return (
    <section className="work-plugins">
      <div className="collection-toolbar">
        <div>
          <h2>可选工作插件</h2>
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
      {notice && (
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
            const installed = data.plugins?.find((c) => c.transport === 'http' && c.url === p.url);
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
                      ? installed.oauthStatus === 'authorized'
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
                            setNotice(`✓ ${p.name} 连接成功，共 ${tools.length} 个工具`);
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
      <button className="text-button" onClick={() => void api.openModule('extensions')}>
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
            <p>{edit.url}</p>
            <OAuthFields edit={edit} onChange={setEdit} />
            {edit.authMode !== 'oauth' && (
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
              <div className="row">
                <span
                  className={
                    'status-pill ' + (current?.oauthStatus === 'authorized' ? 'completed' : '')
                  }
                >
                  {
                    {
                      authorized: '✓ 已授权',
                      waiting: '等待浏览器授权',
                      error: '授权未完成',
                      cancelled: '已取消',
                      none: '尚未授权',
                    }[current?.oauthStatus ?? 'none']
                  }
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || current?.oauthStatus === 'waiting'}
                  onClick={() =>
                    void act(async () => {
                      await save();
                      await api.loginPlugin(edit.id);
                    }, '已打开官方授权流程')
                  }
                >
                  浏览器授权
                </button>
                {current?.oauthStatus === 'waiting' && (
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
