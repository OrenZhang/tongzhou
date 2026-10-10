import { useState } from 'react';
import { Modal } from '../../components/components';
import { EmailFields } from '../chat/NotificationControls';
import { errorMessage } from '../../lib/feedback';
import type { Channel, TongzhouAPI } from '../../shared/types';
type Draft = Channel & { webhook?: string; signingSecret?: string; password?: string };
export function ChannelEditor({
  initial,
  api,
  refresh,
  onClose,
}: {
  initial: Draft;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  onClose: (saved?: boolean) => void;
}) {
  const [channel, setChannel] = useState<Draft>(initial),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const act = async (_key: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="配置通知渠道" onClose={() => onClose()}>
      <form
        className="connection-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act('channel-save', async () => {
            await api.saveChannel(channel);
            await refresh();
            onClose(true);
          });
        }}
      >
        {notice && (
          <p role="alert" className="info-strip">
            {notice}
          </p>
        )}

        <label>
          名称
          <input
            required
            value={channel.name}
            onChange={(e) => setChannel({ ...channel, name: e.target.value })}
          />
        </label>
        {channel.kind === 'email' && <EmailFields channel={channel} onChange={setChannel} />}
        {channel.kind !== 'email' && channel.mode !== 'app' && (
          <label>
            Webhook（留空保留）
            <input
              type="password"
              autoComplete="off"
              value={channel.webhook ?? ''}
              onChange={(e) => setChannel({ ...channel, webhook: e.target.value })}
            />
          </label>
        )}
        {channel.kind !== 'email' && channel.mode !== 'app' && channel.kind !== 'wecom' && (
          <label>
            签名密钥（修改时填写）
            <input
              type="password"
              autoComplete="off"
              value={channel.signingSecret ?? ''}
              onChange={(e) => setChannel({ ...channel, signingSecret: e.target.value })}
            />
          </label>
        )}
        {channel.mode === 'app' && (
          <>
            <label>
              收件人类型
              <select
                aria-label="收件人类型"
                value={channel.receiveIdType ?? 'open_id'}
                onChange={(e) =>
                  setChannel({
                    ...channel,
                    receiveIdType: e.target.value as 'open_id' | 'chat_id',
                  })
                }
              >
                <option value="open_id">个人 open_id</option>
                <option value="chat_id">群 chat_id</option>
              </select>
            </label>
            <label>
              收件人 / 群 ID
              <input
                value={channel.receiveId ?? ''}
                onChange={(e) => setChannel({ ...channel, receiveId: e.target.value })}
              />
            </label>
          </>
        )}
        <div className="row">
          <button className="primary" disabled={!!busy}>
            保存
          </button>
          <button type="button" onClick={() => onClose()}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}
