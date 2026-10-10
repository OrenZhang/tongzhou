import { useEffect, useState } from 'react';
import { ChevronRight, History, Plus, SlidersHorizontal } from 'lucide-react';
import type { BotConfig, Channel, Snapshot, TongzhouAPI } from '../../shared/types';
import { Modal } from '../../components/components';
import { BotConnectionDialog } from '../bots/BotConnectionDialog';
import { BotSettingsPanel } from '../bots/BotSettingsPanel';
import { defaultSmtp } from '../chat/NotificationControls';
import { ChannelEditor } from './ChannelEditor';
import { ChannelDetails } from './ChannelDetails';
import { ChannelRecords } from './ChannelRecords';
import { channelEntries, channelPlatforms, channelStatus } from './channel-catalog';
import './channels.css';

export function ConnectionsPage({
  data,
  api,
  refresh,
}: {
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
}) {
  const entries = channelEntries(data);
  const [selected, setSelected] = useState<string>(entries[0]?.key ?? 'platform:weixin');
  const [showSettings, setShowSettings] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [botRequest, setBotRequest] = useState<{
    kind: BotConfig['kind'];
    bot?: BotConfig;
    reconnect?: boolean;
  } | null>(null);
  const [channelEdit, setChannelEdit] = useState<Channel | null>(null);
  const entry = entries.find((e) => e.key === selected);
  useEffect(() => {
    if (entry) setCollapsed((current) => ({ ...current, [entry.value.kind]: false }));
  }, [entry?.key, entry?.value.kind]);
  useEffect(() => {
    if (/^(bot|notification):/.test(selected) && !entries.some((e) => e.key === selected))
      setSelected(entries[0]?.key ?? 'platform:weixin');
  }, [selected, entries.map((e) => e.key).join('|')]);
  const addNotification = (kind: Channel['kind']) =>
    setChannelEdit({
      id: crypto.randomUUID(),
      name: channelPlatforms[kind].name + '通知',
      kind,
      enabled: true,
      mode: 'webhook',
      ...(kind === 'email' ? { smtp: { ...defaultSmtp, to: [] } } : {}),
    });
  const manage = () => {
    if (!entry) return;
    if (entry.source === 'bot') setBotRequest({ kind: entry.value.kind, bot: entry.value });
    else setChannelEdit(entry.value);
  };
  return (
    <main className="page channels-page">
      <header className="page-heading channel-page-heading">
        <div>
          <h1>渠道</h1>
          <p>连接你的应用，让同舟在其中协作。</p>
        </div>
        <button
          className="text-button channel-settings-toggle"
          aria-expanded={showSettings}
          aria-haspopup="dialog"
          onClick={() => setShowSettings(!showSettings)}
        >
          <SlidersHorizontal size={16} />
          机器人通用设置
        </button>
      </header>
      {showSettings && (
        <Modal compact title="机器人通用设置" onClose={() => setShowSettings(false)}>
          <BotSettingsPanel
            api={api}
            data={data}
            refresh={refresh}
            onClose={() => setShowSettings(false)}
          />
        </Modal>
      )}
      <div className="channel-workspace">
        <nav className="channel-sidebar" aria-label="渠道列表">
          <div className="channel-list-heading">
            <span>内置渠道</span>
          </div>
          {Object.entries(channelPlatforms).map(([kind, platform]) => {
            const connections = entries.filter((item) => item.value.kind === kind);
            const Icon = platform.icon;
            const active = selected === 'platform:' + kind || entry?.value.kind === kind;
            return (
              <div className="channel-platform-group" data-platform={kind} key={kind}>
                <div className="channel-platform-heading">
                  <button
                    className="channel-platform-select"
                    aria-label={platform.name + '渠道'}
                    aria-pressed={active}
                    aria-expanded={connections.length ? !collapsed[kind] : undefined}
                    aria-controls={connections.length ? `channel-connections-${kind}` : undefined}
                    onClick={() => {
                      if (connections.length)
                        setCollapsed((current) => ({ ...current, [kind]: !current[kind] }));
                      else setSelected('platform:' + kind);
                    }}
                  >
                    <span className="channel-platform-icon">
                      <Icon size={18} />
                    </span>
                    <span className="channel-list-copy">
                      <strong>{platform.name}</strong>
                      <small>
                        {connections.length ? '已添加 ' + connections.length + ' 个连接' : '未连接'}
                      </small>
                    </span>
                    {connections.length > 0 && (
                      <ChevronRight
                        className="channel-group-chevron"
                        size={13}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={'添加' + platform.name + '渠道'}
                    title={'添加' + platform.name + '渠道'}
                    onClick={() => setSelected('platform:' + kind)}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <div id={`channel-connections-${kind}`} hidden={!!collapsed[kind]}>
                  {connections.map((item) => {
                    const status = channelStatus(item);
                    return (
                      <button
                        className="channel-list-item channel-instance"
                        key={item.key}
                        aria-pressed={selected === item.key}
                        onClick={() => setSelected(item.key)}
                      >
                        <span className="channel-list-copy">
                          <strong title={item.value.name}>{item.value.name}</strong>
                          <small>
                            <span className="channel-status" data-status={status.status}>
                              {status.label}
                            </span>
                          </small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="channel-utilities">
            <button aria-pressed={selected === 'records'} onClick={() => setSelected('records')}>
              <History size={15} />
              连接记录
            </button>
          </div>
        </nav>
        <div className="channel-content">
          {entry && (
            <ChannelDetails
              key={entry.key}
              entry={entry}
              api={api}
              data={data}
              refresh={refresh}
              manage={manage}
              settings={() => setShowSettings(true)}
              reconnect={() => {
                if (entry.source === 'bot')
                  setBotRequest({ kind: entry.value.kind, bot: entry.value, reconnect: true });
              }}
            />
          )}
          {selected.startsWith('platform:') && (
            <section className="channel-add-panel" aria-label="添加渠道">
              <h2>
                {channelPlatforms[selected.slice(9) as keyof typeof channelPlatforms].name + '渠道'}
              </h2>
              <p>添加连接，可接入多个账号或通知目标。</p>
              <div className="channel-platforms">
                {Object.entries(channelPlatforms)
                  .filter(([kind]) => selected === 'platform:' + kind)
                  .map(([kind, platform]) => {
                    const Icon = platform.icon;
                    return (
                      <div className="channel-platform-option" data-platform={kind} key={kind}>
                        <span className="channel-platform-icon">
                          <Icon size={20} />
                        </span>
                        <div>
                          <h3>{platform.name}</h3>
                          <p>{platform.description}</p>
                        </div>
                        <div className="channel-platform-actions">
                          {kind === 'email' ? (
                            <button className="secondary" onClick={() => addNotification('email')}>
                              连接邮件
                            </button>
                          ) : (
                            <>
                              <button
                                className="secondary"
                                aria-label={`连接${platform.name}`}
                                onClick={() => setBotRequest({ kind: kind as BotConfig['kind'] })}
                              >
                                连接
                              </button>
                              {kind !== 'weixin' && (
                                <button
                                  className="text-button"
                                  aria-label={`${platform.name}仅通知`}
                                  onClick={() => addNotification(kind as Channel['kind'])}
                                >
                                  仅通知
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </section>
          )}
          {selected === 'records' && <ChannelRecords data={data} />}
        </div>
      </div>
      {botRequest && (
        <BotConnectionDialog
          request={botRequest}
          api={api}
          data={data}
          refresh={refresh}
          onClose={(id) => {
            if (id || botRequest.bot) setSelected(`bot:${id ?? botRequest.bot!.id}`);
            setBotRequest(null);
          }}
        />
      )}
      {channelEdit && (
        <ChannelEditor
          initial={channelEdit}
          api={api}
          refresh={refresh}
          onClose={(saved) => {
            if (saved) setSelected(`notification:${channelEdit.id}`);
            setChannelEdit(null);
          }}
        />
      )}
    </main>
  );
}
