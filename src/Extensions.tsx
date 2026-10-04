import { useState } from 'react';
import { Plus, Plug, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Field, Modal, Spinner } from './components';
import { MultiValueInput } from './MultiValueInput';
import {
  OAuthFields,
  WorkPlugins,
  workPluginCatalog,
  PluginAuthStatus,
  workPluginDefinition,
} from './WorkPlugins';
import { errorMessage } from './feedback';
import { CoreCapabilities } from './CoreCapabilities';
import { builtinPlugins } from './shared/builtin-plugins';
import type { AgentProfile, PluginInput, Snapshot, TongzhouAPI } from './shared/types';

export function Extensions({
  api,
  data,
  refresh,
  report,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  refresh: () => Promise<void>;
  report: (e: unknown) => void;
}) {
  const [tab, setTab] = useState<'core' | 'catalog' | 'mcp' | 'skills'>('core');
  const [loginUrl, setLoginUrl] = useState('');
  const [edit, setEdit] = useState<PluginInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<{ id: string; enabled: boolean } | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, { name: string; description: string }[]>>(
    {},
  );
  const [notice, setNotice] = useState('');
  const otherPlugins = (data.plugins ?? []).filter((p) => !workPluginDefinition(p));
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (test = false) => {
    if (!edit) return;
    await api.savePlugin(edit);
    if (test) {
      const tools = await api.testPlugin(edit.id);
      setCatalogs((c) => ({ ...c, [edit.id]: tools }));
      setNotice(`${edit.name}：连接成功，发现 ${tools.length} 个工具`);
    } else setEdit(null);
  };
  return (
    <main className="page extensions-page">
      <div className="page-heading">
        <h1>插件</h1>
        <p>管理公共工具，统一启停能力，所有会话和 Agent 自动继承。切换模型不会切换你的会话记录。</p>
      </div>
      <nav className="section-tabs" aria-label="工具分类">
        {(['core', 'catalog', 'mcp', 'skills'] as const).map((value, i) => (
          <button
            key={value}
            aria-pressed={tab === value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {['核心能力', '工作插件', '内置与自定义', 'Skills'][i]}
            <span className="tab-count">
              {value === 'core'
                ? 3
                : value === 'catalog'
                  ? workPluginCatalog.length
                  : value === 'mcp'
                    ? otherPlugins.length
                    : (data.skills ?? []).length}
            </span>
          </button>
        ))}
      </nav>
      {notice && !edit && tab !== 'mcp' && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      {tab === 'catalog' && (
        <WorkPlugins
          api={api}
          data={data}
          refresh={refresh}
          onCustom={() => setTab('mcp')}
          onManage={(plugin) => {
            setNotice('');
            setLoginUrl('');
            setEdit({ ...plugin, secret: '' });
          }}
        />
      )}
      {tab === 'core' && <CoreCapabilities api={api} data={data} refresh={refresh} />}
      <div hidden={tab !== 'mcp'}>
        <div className="section-heading">
          <div>
            <h2>内置与自定义</h2>
            <p className="muted">内置工具和其他 MCP 服务；应用授权与启停请在“工作插件”中管理。</p>
          </div>
          <button
            className="primary"
            onClick={() => {
              setNotice('');
              setEdit({
                id: crypto.randomUUID(),
                name: '',
                transport: 'stdio',
                command: '',
                args: [],
                url: '',
                enabled: true,
                readOnlyTools: [],
                secret: '',
              });
            }}
          >
            <Plus size={16} />
            添加 MCP
          </button>
        </div>
        <div className="provider-grid">
          {otherPlugins.map((p) => (
            <article className="provider-card" key={p.id}>
              <div className="card-top">
                <Plug />
                <span className="tag">{p.enabled ? '已启用 · 按需连接' : '已停用'}</span>
                <label className="switch-control">
                  <input
                    type="checkbox"
                    aria-label={`启用 ${p.name}`}
                    checked={pendingToggle?.id === p.id ? pendingToggle.enabled : p.enabled}
                    disabled={busy}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setPendingToggle({ id: p.id, enabled });
                      void perform(() => api.savePlugin({ ...p, enabled })).finally(() =>
                        setPendingToggle(null),
                      );
                    }}
                  />
                  <span aria-hidden="true" />
                </label>
              </div>
              <h3>{p.name}</h3>
              <p>
                {builtinPlugins.find((item) => item.id === p.id)?.description ??
                  (p.transport === 'http' ? p.url : [p.command, ...p.args].join(' '))}
              </p>
              <p className="muted">
                {(catalogs[p.id] ?? p.catalog)
                  ? `已发现 ${(catalogs[p.id] ?? p.catalog)!.length} 个工具`
                  : '点击连接检查工具目录'}
              </p>
              <div className="row wrap">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      const tools = await api.testPlugin(p.id);
                      setCatalogs((c) => ({ ...c, [p.id]: tools }));
                      setNotice(`${p.name}：连接成功，发现 ${tools.length} 个工具`);
                    })
                  }
                >
                  <RefreshCw size={14} />
                  连接检查
                </button>
                {!builtinPlugins.some((item) => item.id === p.id) && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setNotice('');
                      setLoginUrl('');
                      setEdit({ ...p, secret: '' });
                    }}
                  >
                    管理插件
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        {!otherPlugins.length && (
          <p className="muted">
            添加本机 stdio 或远程 Streamable HTTP 服务。插件全局启用后，各会话按需使用，无需在 Agent
            中重复配置。
          </p>
        )}
        {notice && (
          <p role="status" className="extension-notice">
            {notice}
          </p>
        )}
      </div>
      <div hidden={tab !== 'skills'}>
        <div className="section-heading">
          <h2>Skills</h2>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => perform(() => api.importSkill())}
          >
            <Upload size={16} />
            导入 Skill 文件夹
          </button>
        </div>
        <p className="muted">
          导入 SKILL.md 及附属文本，复制到同舟本地库。不会自动安装依赖或执行脚本；在 Agent
          和会话中按需使用。
        </p>
        <div className="provider-grid">
          {(data.skills ?? []).map((s) => (
            <article className="provider-card" key={s.id}>
              <h3>{s.name}</h3>
              <p>{s.description}</p>
              <p className="muted">{Object.keys(s.files).length} 个附属文本文件</p>
              <details>
                <summary>查看指令</summary>
                <pre className="skill-preview">{s.instructions}</pre>
              </details>
              <div className="row wrap">
                <label className="checkbox-line">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={busy}
                    onChange={(e) =>
                      perform(() => api.saveSkill({ ...s, enabled: e.target.checked }))
                    }
                  />
                  启用
                </label>
                <button
                  className="text-button danger"
                  disabled={busy}
                  onClick={() => perform(() => api.deleteSkill(s.id))}
                >
                  <Trash2 size={14} />
                  移除
                </button>
              </div>
            </article>
          ))}
        </div>
        {!(data.skills ?? []).length && (
          <div className="empty-state compact">
            <Upload size={26} />
            <h3>添加可复用的工作方法</h3>
            <p>导入 Skill 文件夹，启用后在会话中按需使用。</p>
          </div>
        )}
      </div>
      {edit && (
        <Modal
          title="管理 MCP 插件"
          subtitle="仅添加你信任的服务。本地服务会以当前用户权限运行。"
          onClose={() => setEdit(null)}
        >
          <div className="modal-content">
            <Field label="插件名称">
              <input
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label="连接方式">
              <select
                value={edit.transport}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    transport: e.target.value as 'stdio' | 'http',
                    authMode: e.target.value === 'stdio' ? 'headers' : edit.authMode,
                    secret: '',
                    clearSecret: true,
                  })
                }
              >
                <option value="stdio">本地 stdio</option>
                <option value="http">远程 Streamable HTTP</option>
              </select>
            </Field>
            {edit.transport === 'stdio' ? (
              <>
                <Field
                  label="启动命令"
                  hint="例如 node、npx 或已安装程序的绝对路径；不通过 shell 解释。"
                >
                  <input
                    value={edit.command}
                    onChange={(e) => setEdit({ ...edit, command: e.target.value })}
                  />
                </Field>
                <Field label="启动参数（每行一个）">
                  <MultiValueInput
                    label="启动参数"
                    split={false}
                    value={edit.args}
                    onChange={(args) => setEdit({ ...edit, args })}
                  />
                </Field>
              </>
            ) : (
              <Field label="MCP 服务地址">
                <input
                  value={edit.url}
                  onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                />
              </Field>
            )}
            {edit.transport === 'http' && <OAuthFields edit={edit} onChange={setEdit} />}
            {edit.authMode !== 'oauth' && (
              <Field
                label={edit.transport === 'stdio' ? '环境变量 JSON' : '请求头 JSON'}
                hint={
                  edit.hasSecret
                    ? '已加密保存；留空保留原值。'
                    : '字符串键值对象，例如 {"Authorization":"Bearer …"}。使用系统加密存储。'
                }
              >
                <textarea
                  autoComplete="off"
                  rows={2}
                  value={edit.secret ?? ''}
                  onChange={(e) => setEdit({ ...edit, secret: e.target.value })}
                />
              </Field>
            )}
            {edit.authMode === 'oauth' && (
              <>
                <PluginAuthStatus plugin={data.plugins?.find((p) => p.id === edit.id)} />
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api.savePlugin(edit);
                      setEdit({
                        ...edit,
                        clearSecret: false,
                        oauthClientSecret: '',
                        clearOAuthClientSecret: false,
                      });
                      const result = await api.loginPlugin(edit.id);
                      setLoginUrl(result.url ?? '');
                      setNotice(
                        result.url
                          ? result.browserOpened
                            ? '已打开浏览器，请完成授权。'
                            : '系统浏览器未打开，请点击下方链接继续授权。'
                          : '授权已更新。',
                      );
                    })
                  }
                >
                  保存并浏览器授权
                </button>
                {loginUrl && (
                  <a href={loginUrl} target="_blank" rel="noreferrer">
                    打开授权页面
                  </a>
                )}
                {['starting', 'waiting'].includes(
                  data.plugins?.find((p) => p.id === edit.id)?.oauthStatus ?? '',
                ) && (
                  <button
                    onClick={() =>
                      perform(async () => {
                        await api.cancelPluginLogin(edit.id);
                        setLoginUrl('');
                      })
                    }
                  >
                    取消授权
                  </button>
                )}
              </>
            )}
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={!!edit.clearSecret}
                onChange={(e) => setEdit({ ...edit, clearSecret: e.target.checked })}
              />
              清除已保存的环境变量 / 请求头
            </label>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
              />
              启用插件（所有会话按需连接）
            </label>
            <Field
              label="允许只读 Agent 使用的工具名（每行一个）"
              hint="仅填写你已确认不会修改状态的工具。不会自动信任服务声称的只读属性。"
            >
              <textarea
                rows={2}
                value={edit.readOnlyTools.join('\n')}
                onChange={(e) =>
                  setEdit({ ...edit, readOnlyTools: e.target.value.split('\n').filter(Boolean) })
                }
              />
            </Field>
            {catalogs[edit.id] && (
              <details open>
                <summary>发现的工具</summary>
                <ul>
                  {catalogs[edit.id].map((t) => (
                    <li key={t.name}>
                      <strong>{t.name}</strong> — {t.description.slice(0, 150)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {notice && <p role="status">{notice}</p>}
          </div>
          <div className="modal-footer">
            <button
              className="text-button danger"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await api.deletePlugin(edit.id);
                  setEdit(null);
                })
              }
            >
              删除插件
            </button>
            <span className="spacer" />
            <button className="secondary" disabled={busy} onClick={() => perform(() => save(true))}>
              保存并检查连接
            </button>
            <button className="primary" disabled={busy} onClick={() => perform(() => save())}>
              {busy ? <Spinner /> : null}保存插件
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
