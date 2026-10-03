import { useEffect, useState } from 'react';
import { Plus, Plug, Monitor, RefreshCw, Trash2, Upload, ShieldCheck, Square } from 'lucide-react';
import { Field, Modal, Spinner } from './components';
import { MultiValueInput } from './MultiValueInput';
import { OAuthFields } from './WorkPlugins';
import type {
  AgentProfile,
  ComputerStatus,
  PluginInput,
  Snapshot,
  TongzhouAPI,
} from './shared/types';

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
  const [tab, setTab] = useState<'core' | 'mcp' | 'skills'>('core');
  const [edit, setEdit] = useState<PluginInput | null>(null);
  const [status, setStatus] = useState<ComputerStatus>();
  const [busy, setBusy] = useState(false);
  const [catalogs, setCatalogs] = useState<Record<string, { name: string; description: string }[]>>(
    {},
  );
  const [notice, setNotice] = useState('');
  useEffect(() => {
    api.computerStatus().then(setStatus).catch(report);
  }, [api]);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      report(e);
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
        <h1>插件与工具</h1>
        <p>管理公共工具，统一启停能力，所有会话和 Agent 自动继承。切换模型不会切换你的会话记录。</p>
      </div>
      <nav className="section-tabs" aria-label="工具分类">
        {(['core', 'mcp', 'skills'] as const).map((value, i) => (
          <button
            key={value}
            aria-pressed={tab === value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {['核心能力', 'MCP 插件', 'Skills'][i]}
            <span className="tab-count">
              {value === 'core'
                ? 3
                : value === 'mcp'
                  ? (data.plugins ?? []).length
                  : (data.skills ?? []).length}
            </span>
          </button>
        ))}
      </nav>
      <div className="core-capabilities" hidden={tab !== 'core'}>
        <section className="settings-card">
          <div className="settings-card-title">
            <Monitor />
            <div>
              <h3>电脑控制</h3>
              <p>查看窗口、截图、点击、输入、快捷键、滚动与拖动。</p>
            </div>
          </div>
          <p>
            当前平台：
            {status?.platform === 'win32'
              ? 'Windows'
              : status?.platform === 'darwin'
                ? 'macOS'
                : (status?.platform ?? '检查中')}{' '}
            · 屏幕权限：
            {status?.screen === 'available' ? '无需系统授权' : (status?.screen ?? '检查中')} ·
            辅助功能：
            {!status
              ? '检查中'
              : status.platform === 'win32'
                ? '无需系统授权'
                : status.accessibility
                  ? '已授权'
                  : '未授权'}
          </p>
          <p>
            {status?.diagnostic
              ? `${status.diagnostic.ok ? '✓ 自检通过' : '自检失败'} · ${new Date(status.diagnostic.time).toLocaleString()} · ${status.diagnostic.detail}`
              : '尚未进行本机功能自检'}
          </p>
          <p className="muted">
            需要支持图片与工具调用的模型，截图会发送给当前选用的服务。每次操作展示审批；窗口变化后需重新截图。快捷停止：
            {status?.emergencyShortcut
              ? 'Ctrl / ⌘ + Alt + Esc'
              : '快捷键未注册，请使用下方“停止全部任务”'}
            。
          </p>
          <div className="row wrap">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  setStatus(await api.computerPermission());
                  setNotice(
                    '系统权限状态已刷新 · ' +
                      new Date().toLocaleTimeString() +
                      '；操作效果需通过功能测试确认',
                  );
                })
              }
            >
              <ShieldCheck size={16} />
              检查系统权限
            </button>
            <button
              className="secondary"
              disabled={busy || !status?.supported}
              onClick={() =>
                perform(async () => {
                  const next = await api.computerSelfTest();
                  setStatus(next);
                  setNotice(next.diagnostic?.detail ?? '自检结束');
                })
              }
            >
              本机功能自检（打开测试窗口）
            </button>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={data.capabilities?.computer ?? false}
                onChange={(e) => perform(() => api.setCapability('computer', e.target.checked))}
              />
              启用电脑控制
            </label>
            <button
              className="text-button danger"
              disabled={!data.runs.some((r) => r.status === 'running') || busy}
              onClick={() =>
                perform(async () => {
                  await api.emergencyStop();
                  setNotice('已请求停止所有运行任务');
                })
              }
            >
              <Square size={15} />
              停止全部任务（{data.runs.filter((r) => r.status === 'running').length}）
            </button>
          </div>
        </section>
        <section className="settings-card">
          <h3>客户端管理</h3>
          <p>在会话中查询与管理 Agent、插件、连接和会话。修改沿用操作审批。</p>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={data.capabilities?.management ?? true}
              onChange={(e) => perform(() => api.setCapability('management', e.target.checked))}
            />
            启用客户端管理
          </label>
        </section>
        <section className="settings-card">
          <h3>项目文件与终端</h3>
          <p>内置能力 · 关联项目后可用，按项目范围和只读策略执行。</p>
        </section>
      </div>
      <div hidden={tab !== 'mcp'}>
        <div className="section-heading">
          <h2>MCP 插件</h2>
          <button
            className="secondary"
            disabled={busy || data.plugins?.some((p) => p.id === 'tongzhou-web')}
            onClick={() =>
              perform(async () => {
                await api.installBuiltinPlugin();
                setNotice('已启用内置网页读取与时间工具，无需 API Key；在会话中按需调用');
              })
            }
          >
            启用内置网页与时间
          </button>
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
          {(data.plugins ?? []).map((p) => (
            <article className="provider-card" key={p.id}>
              <div className="card-top">
                <Plug />
                <span className="tag">{p.enabled ? '已启用 · 按需连接' : '已停用'}</span>
                <label className="switch-control">
                  <input
                    type="checkbox"
                    aria-label={`启用 ${p.name}`}
                    checked={p.enabled}
                    disabled={busy}
                    onChange={(e) =>
                      perform(() => api.savePlugin({ ...p, enabled: e.target.checked }))
                    }
                  />
                  <span aria-hidden="true" />
                </label>
              </div>
              <h3>{p.name}</h3>
              <p>{p.transport === 'http' ? p.url : [p.command, ...p.args].join(' ')}</p>
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
                <button
                  className="text-button"
                  onClick={() => {
                    setNotice('');
                    setEdit({ ...p, secret: '' });
                  }}
                >
                  管理插件
                </button>
              </div>
            </article>
          ))}
        </div>
        {!(data.plugins ?? []).length && (
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
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    await api.savePlugin(edit);
                    setEdit({ ...edit, clearSecret: false });
                    await api.loginPlugin(edit.id);
                  })
                }
              >
                保存并浏览器授权
              </button>
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
