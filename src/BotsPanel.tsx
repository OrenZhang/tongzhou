import { useState } from 'react';
import { Bot, Plus, RefreshCw } from 'lucide-react';
import { Modal } from './components';
import { MultiValueInput } from './MultiValueInput';
import type { BotConfig, Snapshot, TongzhouAPI } from './shared/types';
const labels = { feishu: '飞书', wecom: '企业微信', dingtalk: '钉钉' };
const statuses = {
  disabled: '已停用',
  connecting: '连接中',
  listening: '正在监听',
  connected: '已连接',
  error: '连接异常',
};
export function BotsPanel({
  data,
  api,
  refresh,
}: {
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
}) {
  const [edit, setEdit] = useState<(BotConfig & { secret?: string }) | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [armed, setArmed] = useState('');
  const [qr, setQr] = useState<{ id: string; image: string; expiresAt: number } | null>(null);
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
  const create = (kind: BotConfig['kind']) =>
    setEdit({
      id: crypto.randomUUID(),
      name: labels[kind] + '机器人',
      kind,
      appId: '',
      enabled: false,
      allowedSenders: [],
      allowedChats: [],
      allSessions: false,
      sessionIds: [],
      allowExecute: false,
    });
  return (
    <section className="bots-panel">
      <div className="collection-toolbar">
        <div>
          <h2>会话机器人</h2>
          <p>在办公聊天中查看进度、切换会话，按需发起任务。同舟运行时保持连接。</p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void act(
              async () => setQr(await api.onboardBot(crypto.randomUUID(), '飞书机器人')),
              '请用飞书扫码授权',
            )
          }
        >
          飞书扫码接入
        </button>
      </div>
      {notice && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      <div className="row">
        {(['feishu', 'wecom', 'dingtalk'] as const).map((kind) => (
          <button className="secondary" key={kind} onClick={() => create(kind)}>
            <Plus size={14} />
            {labels[kind]}机器人
          </button>
        ))}
      </div>
      <div className="provider-grid service-connections">
        {(data.bots ?? []).map((b) => (
          <article className="provider-card" key={b.id}>
            <div className="service-card-heading row">
              <Bot size={20} />
              <h3>{b.name}</h3>
              <span
                className={
                  'status-pill ' +
                  (b.status === 'connected' ? 'completed' : b.status === 'error' ? 'failed' : '')
                }
              >
                {statuses[b.status ?? 'disabled']}
              </span>
            </div>
            <p>
              {labels[b.kind]} · {b.allowExecute ? '可操作会话' : '仅查看进度'} ·{' '}
              {b.allSessions ? '全部会话' : `${b.sessionIds.length} 个指定会话`}
            </p>
            {b.error && <p className="danger">{b.error}</p>}
            {b.lastMessageAt && (
              <small>最近收到消息：{new Date(b.lastMessageAt).toLocaleString()}</small>
            )}
            <div className="row service-card-actions">
              <button className="secondary" onClick={() => setEdit({ ...b, secret: '' })}>
                管理机器人
              </button>
              <button
                disabled={busy}
                onClick={() => void act(() => api.saveBot({ ...b, enabled: !b.enabled }))}
              >
                {b.enabled ? '停用' : '启用'}
              </button>
              <button
                disabled={busy || !b.enabled}
                onClick={() => void act(() => api.restartBot(b.id), '已重新连接')}
              >
                <RefreshCw size={13} />
                重连
              </button>
              <button
                className="text-button danger"
                disabled={busy}
                onClick={() => {
                  if (armed !== b.id) setArmed(b.id);
                  else void act(() => api.deleteBot(b.id), '已删除机器人');
                }}
              >
                {armed === b.id ? '确认删除' : '删除'}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!(data.bots ?? []).length && (
        <div className="empty-state compact">
          <Bot size={28} />
          <h3>让工作台出现在你的办公聊天中</h3>
          <p>通知只向外发送；机器人可接收命令并操作允许范围内的会话。</p>
        </div>
      )}
      <details className="settings-card">
        <summary>机器人命令与接入说明</summary>
        <p>/sessions 列出会话 · /status 查看进度 · /use ID 切换会话</p>
        <p>/new 标题 · /run 任务 · /stop · /rename 标题 · /archive</p>
        <p>
          飞书：启用机器人及接收消息事件，使用长连接；企业微信：智能机器人 API 模式获取 Bot ID 和
          Secret；钉钉：创建企业内部机器人并启用 Stream。允许用户填写平台用户 ID；群消息额外要求群
          ID。不会开放公网回调端口。
        </p>
      </details>
      {qr && (
        <Modal
          title="飞书机器人扫码授权"
          onClose={() => {
            void api.cancelChannelLogin(qr.id);
            setQr(null);
          }}
        >
          <div className="modal-content connection-form">
            {data.channelAuth?.find((a) => a.id === qr.id)?.phase === 'success' ? (
              <>
                <p>✓ 机器人授权已保存。选择允许用户、会话范围后再启用。</p>
                <button
                  className="primary"
                  onClick={() => {
                    const b = data.bots?.find((b) => b.id === qr.id);
                    if (b) {
                      setEdit(b);
                      setQr(null);
                    }
                  }}
                >
                  配置机器人
                </button>
              </>
            ) : (
              <>
                <img width={256} height={256} src={qr.image} alt="飞书机器人授权二维码" />
                <p>
                  状态：{data.channelAuth?.find((a) => a.id === qr.id)?.phase ?? '等待扫码'} ·{' '}
                  {new Date(qr.expiresAt).toLocaleTimeString()} 到期
                </p>
              </>
            )}
          </div>
        </Modal>
      )}
      {edit && (
        <Modal title={`管理${labels[edit.kind]}机器人`} onClose={() => setEdit(null)}>
          <form
            className="modal-content connection-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api.saveBot(edit);
                setEdit(null);
              });
            }}
          >
            <div className="form-columns">
              <label>
                名称
                <input
                  required
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              </label>
              <label>
                {edit.kind === 'wecom' ? 'Bot ID' : 'App / Client ID'}
                <input
                  required
                  value={edit.appId}
                  onChange={(e) => setEdit({ ...edit, appId: e.target.value })}
                />
              </label>
            </div>
            {edit.kind === 'feishu' && (
              <label>
                区域
                <select
                  value={edit.domain ?? 'feishu'}
                  onChange={(e) =>
                    setEdit({ ...edit, domain: e.target.value as 'feishu' | 'lark' })
                  }
                >
                  <option value="feishu">飞书</option>
                  <option value="lark">Lark</option>
                </select>
              </label>
            )}
            <label>
              应用密钥（留空保留）
              <input
                type="password"
                autoComplete="new-password"
                value={edit.secret ?? ''}
                onChange={(e) => setEdit({ ...edit, secret: e.target.value })}
              />
            </label>
            <label>
              允许用户 ID
              <MultiValueInput
                label="允许用户 ID"
                value={edit.allowedSenders}
                onChange={(allowedSenders) => setEdit({ ...edit, allowedSenders })}
              />
            </label>
            <label>
              允许群 ID（空白仅允许私聊）
              <MultiValueInput
                label="允许群 ID"
                value={edit.allowedChats}
                onChange={(allowedChats) => setEdit({ ...edit, allowedChats })}
              />
            </label>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={edit.allSessions}
                onChange={(e) => setEdit({ ...edit, allSessions: e.target.checked })}
              />
              允许访问全部会话
            </label>
            {!edit.allSessions && (
              <div className="session-checklist" role="group" aria-label="允许的会话">
                {data.sessions
                  .filter((s) => !s.archived && !s.parentId)
                  .map((s) => (
                    <label className="checkbox-line" key={s.id}>
                      <input
                        type="checkbox"
                        checked={edit.sessionIds.includes(s.id)}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            sessionIds: e.target.checked
                              ? [...edit.sessionIds, s.id]
                              : edit.sessionIds.filter((id) => id !== s.id),
                          })
                        }
                      />
                      <span>{s.title}</span>
                    </label>
                  ))}
                {!data.sessions.length && <p>暂无会话，可先在工作空间创建。</p>}
              </div>
            )}
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={edit.allowExecute}
                onChange={(e) => setEdit({ ...edit, allowExecute: e.target.checked })}
              />
              允许发起、停止、重命名和归档会话
            </label>
            <p>开启后仍遵循会话执行权限；工具批准需要回到本机。查询只返回标题和状态。</p>
            {edit.allowExecute && (
              <label>
                新建会话默认项目
                <select
                  value={edit.defaultProjectId ?? ''}
                  onChange={(e) =>
                    setEdit({ ...edit, defaultProjectId: e.target.value || undefined })
                  }
                >
                  <option value="">普通聊天</option>
                  {data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
              />
              保存后启用机器人
            </label>
            <div className="row">
              <button className="primary" disabled={busy}>
                保存机器人
              </button>
              <button type="button" onClick={() => setEdit(null)}>
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
