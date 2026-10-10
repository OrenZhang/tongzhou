import { useState } from 'react';
import { errorMessage } from '../../lib/feedback';
import type { NotificationTarget, Snapshot, TongzhouAPI } from '../../shared/types';
import { ChannelRules } from './ChannelRules';

export function ChannelNotifications({
  targets,
  data,
  api,
  refresh,
  manage,
}: {
  targets: NotificationTarget[];
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  manage: () => void;
}) {
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [composing, setComposing] = useState(false),
    [rules, setRules] = useState(false);
  const [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const target = targets.find((t) => t.id === targetId) ?? targets[0];
  return (
    <div className="channel-notifications">
      {!target ? (
        <p className="muted">
          还没有可用接收人。
          <button className="text-button" onClick={manage}>
            配置接收人
          </button>
        </p>
      ) : (
        <>
          <label>
            接收人
            <select
              aria-label="渠道接收人"
              value={target.id}
              onChange={(e) => setTargetId(e.target.value)}
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {!target.available && (
            <p role="status" className="info-strip">
              {target.reason ?? '当前接收人不可用'}
            </p>
          )}
          <div className="row channel-inline-actions">
            <button
              className="text-button"
              disabled={!target.available}
              aria-expanded={composing}
              onClick={() => setComposing(!composing)}
            >
              发送消息 / 测试
            </button>
            <button className="text-button" aria-expanded={rules} onClick={() => setRules(!rules)}>
              通知规则
            </button>
          </div>
          {composing && (
            <form
              className="channel-send-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!target.available || !text.trim() || busy) return;
                setBusy(true);
                setNotice('');
                try {
                  const result = await api.sendChannel(target.id, text.trim());
                  if (result.status !== 'sent') throw new Error(result.error ?? '平台未确认发送');
                  setText('');
                  setNotice('平台已确认发送');
                } catch (error) {
                  setNotice(errorMessage(error));
                } finally {
                  try {
                    await refresh();
                  } catch (error) {
                    setNotice((previous) => `${previous}；记录刷新失败：${errorMessage(error)}`);
                  }
                  setBusy(false);
                }
              }}
            >
              <label>
                消息内容
                <textarea
                  required
                  maxLength={4000}
                  value={text}
                  rows={3}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <button className="primary" disabled={busy || !target.available || !text.trim()}>
                {busy ? '发送中…' : '发送此消息'}
              </button>
            </form>
          )}
          {notice && (
            <p role="status" className="info-strip">
              {notice}
            </p>
          )}
          {rules && <ChannelRules targets={targets} api={api} data={data} refresh={refresh} />}
        </>
      )}
    </div>
  );
}
