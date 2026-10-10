import { useState } from 'react';
import { Modal } from '../../components/components';
import { RuleConditions } from '../chat/NotificationControls';
import { errorMessage } from '../../lib/feedback';
import type {
  NotificationRule,
  NotificationTarget,
  Snapshot,
  TongzhouAPI,
} from '../../shared/types';
export function ChannelRules({
  api,
  data,
  refresh,
  targets,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  refresh: () => Promise<void>;
  targets: NotificationTarget[];
}) {
  const [rule, setRule] = useState<NotificationRule | null>(null),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(''),
    [armed, setArmed] = useState('');
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const target = targets.find((t) => t.id === targetId) ?? targets[0];
  const rules = (data.notificationRules ?? []).filter((r) =>
    targets.some((t) => t.id === r.channelId),
  );
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setNotice('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="channel-rules">
      {notice && !rule && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      <div className="row">
        {targets.length > 1 && (
          <select
            aria-label="通知接收人"
            value={target?.id ?? ''}
            onChange={(e) => setTargetId(e.target.value)}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <button
          className="secondary"
          disabled={!target?.available}
          onClick={() =>
            setRule({
              id: crypto.randomUUID(),
              channelId: target!.id,
              sessionId: null,
              enabled: true,
              once: false,
              events: ['completed', 'failed'],
              template: '同舟：{title} · {status}（{model}）',
            })
          }
        >
          添加通知规则
        </button>
      </div>
      {rule && (
        <Modal title="通知规则" onClose={() => setRule(null)}>
          <form
            className="connection-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act('rule-save', async () => {
                await api.saveNotificationRule(rule);
                setRule(null);
              });
            }}
          >
            {notice && (
              <p role="alert" className="info-strip">
                {notice}
              </p>
            )}
            <label>
              会话范围
              <select
                aria-label="会话范围"
                value={rule.sessionId ?? ''}
                onChange={(e) => setRule({ ...rule, sessionId: e.target.value || null })}
              >
                <option value="">全部会话</option>
                {data.sessions
                  .filter((s) => !s.parentId && !s.archived)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
              </select>
            </label>
            <div className="row">
              {(['ended', 'completed', 'failed', 'interrupted', 'approval'] as const).map(
                (event, i) => (
                  <label key={event}>
                    <input
                      type="checkbox"
                      checked={rule.events.includes(event)}
                      onChange={(e) =>
                        setRule({
                          ...rule,
                          events: e.target.checked
                            ? [...rule.events, event]
                            : rule.events.filter((x) => x !== event),
                        })
                      }
                    />
                    {['轮次结束', '完成', '失败', '停止', '等待批准'][i]}
                  </label>
                ),
              )}
            </div>
            <RuleConditions rule={rule} data={data} onChange={setRule} />
            <label>
              <input
                type="checkbox"
                checked={rule.once}
                onChange={(e) => setRule({ ...rule, once: e.target.checked })}
              />
              只发送一次
            </label>
            <label>
              模板
              <textarea
                value={rule.template}
                onChange={(e) => setRule({ ...rule, template: e.target.value })}
              />
            </label>
            <p>可用字段：{'{title} {status} {model} {time}'}，默认不发送聊天正文或文件内容。</p>
            <div className="row">
              <button className="primary" disabled={!!busy || !rule.events.length}>
                保存规则
              </button>
              <button type="button" onClick={() => setRule(null)}>
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
      <div className="rule-heading">
        <h2>
          通知规则 <span className="tag">{rules.length}</span>
        </h2>
        <p>按会话选择触发条件；应用关闭时不会发送。</p>
      </div>
      {!rules.length && (
        <p className="empty-record">暂无通知规则，在渠道中选择“添加通知规则”即可开始。</p>
      )}
      {rules.map((r) => (
        <div className="connection-record notification-rule" key={r.id}>
          <div className="rule-detail">
            <strong>
              {data.channels?.find((c) => c.id === r.channelId)?.name ??
                data.notificationTargets?.find((t) => t.id === r.channelId)?.name ??
                '已删除通知目标'}
            </strong>
            <p>
              {r.sessionId
                ? (data.sessions.find((s) => s.id === r.sessionId)?.title ?? '已删除会话')
                : '全部会话'}{' '}
              · {r.once ? '仅一次' : '持续'} ·{' '}
              {r.events
                .map(
                  (event) =>
                    ({
                      completed: '完成',
                      failed: '失败',
                      interrupted: '停止',
                      approval: '等待批准',
                      ended: '轮次结束',
                    })[event],
                )
                .join('、')}
            </p>
          </div>
          <span className={'status-pill ' + (r.enabled ? 'completed' : '')}>
            {r.enabled ? '启用' : '停用'}
          </span>
          <div className="row">
            <button onClick={() => setRule(r)}>编辑</button>
            <button
              onClick={() =>
                void act(r.id, () => api.saveNotificationRule({ ...r, enabled: !r.enabled }))
              }
            >
              切换启停
            </button>
            <button
              className="text-button danger"
              onClick={() => {
                if (armed !== r.id) setArmed(r.id);
                else void act(r.id, () => api.deleteNotificationRule(r.id));
              }}
            >
              {armed === r.id ? '确认删除规则' : '删除规则'}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
