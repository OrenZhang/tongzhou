import { t as tr } from '../../shared/i18n';
import { useState } from 'react';
import {
  Bell,
  ChevronDown,
  ChevronRight,
  History,
  MessageSquare,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { Snapshot, TongzhouAPI } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';
import {
  channelPlatforms,
  channelStatus,
  channelTargets,
  supportsNotifications,
  type ChannelEntry,
} from './channel-catalog';
import { ChannelNotifications } from './ChannelNotifications';
import { ChannelRecords } from './ChannelRecords';

export function ChannelDetails({
  entry,
  data,
  api,
  refresh,
  manage,
  reconnect,
  settings,
}: {
  entry: ChannelEntry;
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  manage: () => void;
  reconnect: () => void;
  settings: () => void;
}) {
  const [expanded, setExpanded] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [armed, setArmed] = useState(false);
  const platform = channelPlatforms[entry.value.kind],
    Icon = platform.icon;
  const status = channelStatus(entry),
    targets = channelTargets(entry, data.notificationTargets ?? []);
  const act = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice('');
    try {
      const result = await fn();
      setNotice(typeof result === 'string' ? result : success);
      await refresh();
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setExpanded(expanded === id ? '' : id);
  return (
    <section
      className="channel-details"
      data-platform={entry.value.kind}
      aria-label={tr('渠道详情')}
    >
      <header className="channel-detail-heading">
        <span className="channel-platform-icon">
          <Icon size={22} />
        </span>
        <div>
          <h2>{entry.value.name}</h2>
          <p>
            {platform.name} ·{' '}
            {entry.source === 'bot'
              ? tr('机器人连接')
              : entry.value.kind === 'email'
                ? tr('SMTP 邮件')
                : entry.value.mode === 'app'
                  ? tr('应用通知')
                  : tr('Webhook 通知')}
          </p>
        </div>
        <span className="channel-status" data-status={status.status}>
          {status.label}
        </span>
      </header>
      <div className="channel-account">
        <span className="muted">{entry.source === 'bot' ? tr('应用 / 账号') : tr('发送目标')}</span>
        <span>
          {entry.source === 'bot'
            ? entry.value.appId
            : entry.value.kind === 'email'
              ? entry.value.smtp?.to.join('、') || tr('未设置收件人')
              : entry.value.receiveId || tr('已保存的 Webhook')}
        </span>
        <button className="text-button" onClick={manage}>
          {tr('管理授权')}
        </button>
      </div>
      {entry.source === 'bot' && entry.value.error && (
        <p role="alert" className="info-strip danger">
          {entry.value.error}
        </p>
      )}
      <p className="channel-section-label">{tr('可使用的功能')}</p>
      {entry.source === 'bot' && (
        <>
          <button
            className="channel-capability"
            aria-expanded={expanded === 'chat'}
            onClick={() => toggle('chat')}
          >
            <MessageSquare size={18} />
            <span>
              <strong>{tr('机器人对话')}</strong>
              <small>{tr('聊天、查看进度、操作工作台')}</small>
            </span>
            {expanded === 'chat' ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {expanded === 'chat' && (
            <div className="channel-capability-body">
              <p>
                {data.botSettings?.mode === 'chat' ? tr('仅聊天') : tr('控制工作台')} ·{' '}
                {entry.value.allowedSenders.length}
                {tr(' 位允许用户')}
                {entry.value.kind !== 'weixin' &&
                  tr(' · {0} 个允许群聊', [entry.value.allowedChats.length])}
              </p>
              <div className="row">
                <button className="text-button" onClick={settings}>
                  {tr('机器人通用设置')}
                </button>
                <button className="text-button" onClick={manage}>
                  {tr('管理允许用户')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {supportsNotifications(entry) && (
        <>
          <button
            className="channel-capability"
            aria-expanded={expanded === 'notifications'}
            onClick={() => toggle('notifications')}
          >
            <Bell size={18} />
            <span>
              <strong>{entry.value.kind === 'email' ? tr('邮件通知') : tr('消息通知')}</strong>
              <small>{tr('接收会话结果与定时任务提醒')}</small>
            </span>
            {expanded === 'notifications' ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {expanded === 'notifications' && (
            <div className="channel-capability-body">
              <ChannelNotifications
                targets={targets}
                api={api}
                data={data}
                refresh={refresh}
                manage={manage}
              />
            </div>
          )}
        </>
      )}
      <div className="channel-detail-actions">
        {entry.source === 'bot' ? (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void act(() => api.restartBot(entry.value.id), tr('已请求重新连接，请查看连接状态'))
            }
          >
            <RefreshCw size={14} />
            {tr('重新连接')}
          </button>
        ) : entry.value.kind === 'email' ? (
          <button
            className="text-button"
            disabled={busy || !entry.value.enabled}
            onClick={() => void act(() => api.testEmail(entry.value.id), tr('SMTP 验证完成'))}
          >
            <RefreshCw size={14} />
            {tr('验证 SMTP')}
          </button>
        ) : (
          <button className="text-button" onClick={() => setExpanded('notifications')}>
            {tr('发送测试消息')}
          </button>
        )}
        {entry.source === 'bot' && entry.value.kind === 'weixin' && (
          <button className="text-button" disabled={busy} onClick={reconnect}>
            {tr('重新扫码')}
          </button>
        )}
        {entry.source === 'notification' && !entry.value.enabled && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void act(
                () => api.saveChannel({ ...entry.value, enabled: true }),
                tr('已恢复连接配置'),
              )
            }
          >
            {tr('恢复连接')}
          </button>
        )}
        <button
          className="text-button"
          aria-expanded={expanded === 'records'}
          onClick={() => toggle('records')}
        >
          <History size={14} />
          {tr('最近记录')}
        </button>
        <button
          className="text-button danger channel-delete"
          disabled={busy}
          onClick={() => {
            if (!armed) setArmed(true);
            else
              void act(
                () =>
                  entry.source === 'bot'
                    ? api.deleteBot(entry.value.id)
                    : api.deleteChannel(entry.value.id),
                tr('已删除渠道'),
              );
          }}
        >
          <Trash2 size={14} />
          {armed ? tr('确认删除渠道') : tr('删除')}
        </button>
        {armed && (
          <button className="text-button" onClick={() => setArmed(false)}>
            {tr('取消删除')}
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      {expanded === 'records' && (
        <ChannelRecords
          data={data}
          connectionId={entry.value.id}
          targetIds={[entry.value.id, ...targets.map((t) => t.id)]}
        />
      )}
    </section>
  );
}
