import { useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import { Modal } from './components';
import { MultiValueInput } from './MultiValueInput';
import type {
  Channel,
  NotificationRule,
  Run,
  Session,
  Snapshot,
  TongzhouAPI,
} from './shared/types';
export const defaultSmtp = {
  host: '',
  port: 465,
  secure: true,
  user: '',
  from: '',
  to: [] as string[],
  subject: '同舟 · 会话进展',
};
export function EmailFields({
  channel,
  onChange,
}: {
  channel: Channel & { password?: string };
  onChange: (c: Channel & { password?: string }) => void;
}) {
  const s = channel.smtp ?? defaultSmtp;
  const set = (patch: Partial<typeof s>) => onChange({ ...channel, smtp: { ...s, ...patch } });
  return (
    <>
      <div className="form-columns">
        <label>
          SMTP 服务器
          <input
            required
            value={s.host}
            placeholder="smtp.example.com"
            onChange={(e) => set({ host: e.target.value })}
          />
        </label>
        <label>
          端口
          <input
            type="number"
            min={1}
            max={65535}
            required
            value={s.port}
            onChange={(e) => set({ port: Number(e.target.value) })}
          />
        </label>
      </div>
      <label>
        传输加密
        <select
          aria-label="传输加密"
          value={s.secure ? 'tls' : 'starttls'}
          onChange={(e) =>
            set({ secure: e.target.value === 'tls', port: e.target.value === 'tls' ? 465 : 587 })
          }
        >
          <option value="tls">TLS（通常 465）</option>
          <option value="starttls">STARTTLS（通常 587）</option>
        </select>
      </label>
      <label>
        登录账号
        <input autoComplete="off" value={s.user} onChange={(e) => set({ user: e.target.value })} />
      </label>
      <label>
        邮箱授权码 / 密码（留空保留）
        <input
          type="password"
          autoComplete="new-password"
          value={channel.password ?? ''}
          onChange={(e) => onChange({ ...channel, password: e.target.value })}
        />
      </label>
      <label>
        发件邮箱
        <input
          type="email"
          required
          value={s.from}
          onChange={(e) => set({ from: e.target.value })}
        />
      </label>
      <label>
        收件人
        <MultiValueInput label="收件人邮箱" value={s.to} onChange={(to) => set({ to })} />
      </label>
      <label>
        邮件主题
        <input required value={s.subject} onChange={(e) => set({ subject: e.target.value })} />
      </label>
      <p>保存不会发信。可先验证连接，再通过通知规则或发送测试邮件确认送达。</p>
    </>
  );
}
export function RuleConditions({
  rule,
  data,
  onChange,
}: {
  rule: NotificationRule;
  data: Snapshot;
  onChange: (r: NotificationRule) => void;
}) {
  return (
    <details className="rule-conditions">
      <summary>条件筛选</summary>
      <div className="connection-form">
        <label>
          所属项目
          <select
            aria-label="所属项目"
            value={rule.projectId ?? ''}
            onChange={(e) => onChange({ ...rule, projectId: e.target.value || undefined })}
          >
            <option value="">不限项目</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型（空白表示不限）
          <MultiValueInput
            label="筛选模型"
            value={rule.models ?? []}
            onChange={(models) => onChange({ ...rule, models })}
          />
        </label>
        <label>
          仅执行超过这些秒数时通知
          <input
            type="number"
            min={0}
            max={604800}
            value={rule.minDurationSeconds ?? 0}
            onChange={(e) => onChange({ ...rule, minDurationSeconds: Number(e.target.value) })}
          />
        </label>
      </div>
    </details>
  );
}
export function SessionNotification({
  session,
  run,
  data,
  api,
  onError,
}: {
  session: Session;
  run?: Run;
  data: Snapshot;
  api: TongzhouAPI;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false),
    [channelId, setChannelId] = useState(''),
    [busy, setBusy] = useState(false);
  const rules = (data.notificationRules ?? []).filter(
    (r) => r.sessionId === session.id && r.enabled,
  );
  const channels = (data.channels ?? []).filter((c) => c.enabled);
  return (
    <>
      <button
        className="icon-button"
        aria-label="会话通知"
        title={rules.length ? `已启用 ${rules.length} 条提醒` : '会话通知'}
        onClick={() => {
          setChannelId(channels[0]?.id ?? '');
          setOpen(true);
        }}
      >
        {rules.length ? <BellRing size={16} /> : <Bell size={16} />}
      </button>
      {open && (
        <Modal title="会话通知" onClose={() => setOpen(false)}>
          <div className="modal-content connection-form">
            <p>
              {run ? '当前轮次结束时提醒一次。' : '下一轮结束时提醒一次。'}
              持续提醒和条件筛选可在连接中心的通知规则中配置。
            </p>
            <label>
              通知目标
              <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                {!channels.length && <option value="">请先在连接中心添加通知目标</option>}
                {channels.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary"
              disabled={!channelId || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.saveNotificationRule({
                    id: crypto.randomUUID(),
                    channelId,
                    sessionId: session.id,
                    once: true,
                    enabled: true,
                    events: ['ended'],
                    targetRunId: run?.id,
                    template: '同舟：{title} · {status}（{model}）',
                  });
                  setOpen(false);
                } catch (e) {
                  onError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {run ? '提醒本轮结束' : '提醒下一轮结束'}
            </button>
            {rules.map((r) => (
              <div className="row" key={r.id}>
                <span>
                  {channels.find((c) => c.id === r.channelId)?.name ?? '已停用目标'} ·{' '}
                  {r.once ? '一次' : '持续'}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    api
                      .saveNotificationRule({ ...r, enabled: false, targetRunId: undefined })
                      .catch(onError)
                  }
                >
                  停用提醒
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
