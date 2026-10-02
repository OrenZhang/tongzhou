import { useEffect, useState } from 'react';
import { Plus, Plug, Monitor, RefreshCw, Trash2, Upload, ShieldCheck, Square } from 'lucide-react';
import { Field, Modal, Spinner } from './components';
import type {
  AgentProfile,
  ComputerStatus,
  PluginInput,
  Snapshot,
  TongzhouAPI,
} from './shared/types';

export function AgentTools({
  agent,
  onChange,
  data,
}: {
  agent: AgentProfile;
  onChange: (a: AgentProfile) => void;
  data: Snapshot;
}) {
  const toggle = (key: 'pluginIds' | 'skillIds', id: string, checked: boolean) =>
    onChange({
      ...agent,
      [key]: checked
        ? [...new Set([...(agent[key] ?? []), id])]
        : (agent[key] ?? []).filter((v) => v !== id),
    });
  return (
    <fieldset className="tool-permissions">
      <legend>工具与 Skills</legend>
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={!!agent.computerEnabled}
          onChange={(e) => onChange({ ...agent, computerEnabled: e.target.checked })}
        />
        电脑控制（截图、鼠标、键盘）
      </label>
      <p className="muted">
        只读 Agent 仅可查看窗口和截图。启用的工具在普通聊天中也可使用，每次调用需批准。
      </p>
      {(data.plugins ?? []).map((p) => (
        <label className="checkbox-line" key={p.id}>
          <input
            type="checkbox"
            checked={(agent.pluginIds ?? []).includes(p.id)}
            onChange={(e) => toggle('pluginIds', p.id, e.target.checked)}
          />
          {p.name} · MCP{!p.enabled ? '（已停用）' : ''}
        </label>
      ))}
      {(data.skills ?? []).map((s) => (
        <label className="checkbox-line" key={s.id}>
          <input
            type="checkbox"
            checked={(agent.skillIds ?? []).includes(s.id)}
            onChange={(e) => toggle('skillIds', s.id, e.target.checked)}
          />
          {s.name} · Skill{!s.enabled ? '（已停用）' : ''}
        </label>
      ))}
    </fieldset>
  );
}

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
  const [edit, setEdit] = useState<PluginInput | null>(null);
  const [status, setStatus] = useState<ComputerStatus>();
  const [busy, setBusy] = useState(false);
  const [catalogs, setCatalogs] = useState<Record<string, { name: string; description: string }[]>>(
    {},
  );
  const [notice, setNotice] = useState('');
  const [defaultTools, setDefaultTools] = useState<AgentProfile | null>(null);
  const builder = data.agents.find((a) => a.id === 'builder');
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
        <div className="eyebrow">TOOLS & SKILLS</div>
        <h1>让同舟动手完成任务。</h1>
        <p>管理公共工具，为不同模型和 Agent 分配能力。切换模型不会切换你的会话记录。</p>
      </div>
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
          · 屏幕权限：{status?.screen ?? '检查中'} · 辅助功能：
          {status?.accessibility ? '可用' : '未授权'}
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
            onClick={() => perform(async () => setStatus(await api.computerPermission()))}
          >
            <ShieldCheck size={16} />
            检查系统权限
          </button>
          <button
            className="secondary"
            onClick={() => setDefaultTools(builder ? { ...builder } : null)}
          >
            配置默认助手工具
          </button>
          <button className="text-button danger" onClick={() => perform(() => api.emergencyStop())}>
            <Square size={15} />
            停止全部任务
          </button>
        </div>
      </section>
      <div className="section-heading">
        <h2>MCP 插件</h2>
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
            </div>
            <h3>{p.name}</h3>
            <p>{p.transport === 'http' ? p.url : [p.command, ...p.args].join(' ')}</p>
            <p className="muted">
              {catalogs[p.id] ? `已发现 ${catalogs[p.id].length} 个工具` : '点击连接检查工具目录'}
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
          添加本机 stdio 或远程 Streamable HTTP 服务。配置后在 Agent
          中勾选插件，才会向模型提供工具。
        </p>
      )}
      {notice && (
        <p role="status" className="extension-notice">
          {notice}
        </p>
      )}
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
        中勾选后生效。
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
                  <textarea
                    rows={3}
                    value={edit.args.join('\n')}
                    onChange={(e) =>
                      setEdit({ ...edit, args: e.target.value.split('\n').filter(Boolean) })
                    }
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
              启用插件（被选用的 Agent 运行时连接）
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
      {defaultTools && (
        <Modal
          title="默认助手工具"
          subtitle="普通聊天也使用此配置；其他 Agent 在各自配置页设置。"
          onClose={() => setDefaultTools(null)}
        >
          <div className="modal-content">
            <AgentTools agent={defaultTools} data={data} onChange={setDefaultTools} />
          </div>
          <div className="modal-footer">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await api.saveAgent(defaultTools);
                  setDefaultTools(null);
                })
              }
            >
              保存工具配置
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
