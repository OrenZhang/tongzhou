import { useState } from 'react';
import { Modal } from '../../components/components';
import { EmailFields, RuleConditions, defaultSmtp } from '../chat/NotificationControls';
import { BotsPanel } from './BotsPanel';
import { NetworkProfilesPanel } from './NetworkProfilesPanel';
import { errorMessage } from '../../lib/feedback';
import { Globe2, Radio, History, Bot, Network } from 'lucide-react';
import type {
  Channel,
  Connector,
  NotificationRule,
  Snapshot,
  TongzhouAPI,
} from '../../shared/types';

export function ConnectionsPanel({
  api,
  data,
  refresh,
  initialTab = 'accounts',
}: {
  api: TongzhouAPI;
  data: Snapshot;
  refresh: () => Promise<void>;
  initialTab?: 'accounts' | 'network';
}) {
  const [tab, setTab] = useState<'accounts' | 'channels' | 'bots' | 'records' | 'network'>(
    initialTab,
  );
  const [connector, setConnector] = useState<(Connector & { secret?: string }) | null>(null);
  const [channel, setChannel] = useState<
    (Channel & { webhook?: string; signingSecret?: string; password?: string }) | null
  >(null);
  const [rule, setRule] = useState<NotificationRule | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [armed, setArmed] = useState('');
  const [send, setSend] = useState<{ id: string; text: string } | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>, success = '已保存') => {
    setBusy(key);
    setNotice('');
    try {
      const result = await fn();
      setNotice(typeof result === 'string' ? result : success);
      await refresh();
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy('');
    }
  };
  const destructive = (id: string, action: () => Promise<unknown>) => {
    if (armed !== id) {
      setArmed(id);
      return;
    }
    void act(id, action, '已清理');
    setArmed('');
  };
  return (
    <section className="connections-extra">
      <nav className="section-tabs connection-tabs" aria-label="连接分类">
        {(['accounts', 'channels', 'bots', 'network', 'records'] as const).map((name, i) => (
          <button
            className={tab === name ? 'active' : ''}
            aria-pressed={tab === name}
            key={name}
            onClick={() => setTab(name)}
          >
            {(() => {
              const Icon = [Globe2, Radio, Bot, Network, History][i];
              return <Icon size={15} />;
            })()}
            {['服务与浏览器', '渠道通知', '机器人', '网络配置', '认证与发送记录'][i]}
          </button>
        ))}
      </nav>
      {notice && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      {tab === 'bots' && <BotsPanel data={data} api={api} refresh={refresh} />}
      {tab === 'network' && <NetworkProfilesPanel api={api} />}
      {tab === 'accounts' && (
        <>
          <div className="collection-toolbar">
            <div>
              <h2>浏览器账号</h2>
              <p>按账号独立保存网站登录态，模型不会收到保存的 Cookie。</p>
            </div>
          </div>
          <button
            className="secondary"
            onClick={() => {
              setNotice('');
              setConnector({
                id: crypto.randomUUID(),
                name: '浏览器账号',
                kind: 'browser',
                enabled: true,
                baseUrl: 'https://',
              });
            }}
          >
            添加浏览器账号
          </button>
          <div className="provider-grid service-connections">
            {(data.connectors ?? [])
              .filter((c) => c.kind === 'browser')
              .map((c) => (
                <article className="provider-card" key={c.id}>
                  <div className="row service-card-heading">
                    <h3>{c.name}</h3>
                    <span className="tag">{c.enabled ? '独立登录态' : '已停用'}</span>
                  </div>
                  <p>{c.baseUrl}</p>
                  <div className="row service-card-actions">
                    <button
                      className="secondary"
                      onClick={() => {
                        setNotice('');
                        setConnector({ ...c });
                      }}
                    >
                      管理
                    </button>
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void act(c.id, () => api.saveConnector({ ...c, enabled: !c.enabled }))
                      }
                    >
                      {c.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      disabled={!c.enabled || !!busy}
                      onClick={() =>
                        void act(
                          c.id,
                          () => api.openBrowserProfile(c.id),
                          '已打开独立浏览器；完成登录后可关闭窗口',
                        )
                      }
                    >
                      打开浏览器
                    </button>
                    <button
                      className="text-button danger"
                      onClick={() =>
                        destructive('clear-' + c.id, () => api.clearBrowserProfile(c.id))
                      }
                    >
                      {armed === 'clear-' + c.id ? '确认清除登录态' : '清除登录态'}
                    </button>
                    <button
                      className="text-button danger"
                      onClick={() => destructive(c.id, () => api.deleteConnector(c.id))}
                    >
                      {armed === c.id ? '确认删除账号及登录态' : '删除'}
                    </button>
                  </div>
                </article>
              ))}
          </div>
          {!(data.connectors ?? []).some((c) => c.kind === 'browser') && !connector && (
            <div className="empty-state compact">
              <Globe2 size={28} />
              <h3>添加浏览器账号</h3>
              <p>独立保存网站登录态，可配合电脑控制操作网页。应用认证在插件页管理。</p>
            </div>
          )}
          {connector && (
            <Modal title="配置浏览器账号" onClose={() => setConnector(null)}>
              <form
                className="connection-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('connector-save', async () => {
                    await api.saveConnector(connector);
                    setConnector(null);
                  });
                }}
              >
                {notice && (
                  <p role="status" className="info-strip">
                    {notice}
                  </p>
                )}
                <label>
                  名称
                  <input
                    required
                    value={connector.name}
                    onChange={(e) => setConnector({ ...connector, name: e.target.value })}
                  />
                </label>
                <label>
                  站点地址
                  <input
                    required
                    type="url"
                    value={connector.baseUrl}
                    onChange={(e) => setConnector({ ...connector, baseUrl: e.target.value })}
                  />
                </label>
                <p>独立浏览器保存本站登录态，不读取系统浏览器 Cookie。</p>
                <div className="row">
                  <button className="primary" disabled={!!busy}>
                    保存
                  </button>
                  <button type="button" onClick={() => setConnector(null)}>
                    取消
                  </button>
                </div>
              </form>
            </Modal>
          )}
        </>
      )}
      {tab === 'channels' && (
        <>
          <div className="collection-toolbar channel-intro">
            <div>
              <h2>通知渠道</h2>
              <p>把完成、失败或等待批准的状态发送到指定群或个人。</p>
            </div>
          </div>
          <div className="row">
            {(['feishu', 'wecom', 'dingtalk', 'email'] as const).map((kind, i) => (
              <button
                className="secondary"
                key={kind}
                onClick={() =>
                  setChannel({
                    id: crypto.randomUUID(),
                    name: ['飞书', '企业微信', '钉钉', '邮件'][i],
                    kind,
                    enabled: true,
                    smtp: kind === 'email' ? defaultSmtp : undefined,
                  })
                }
              >
                添加 {['飞书', '企业微信', '钉钉', '邮件'][i]}
              </button>
            ))}
          </div>
          <div className="provider-grid channel-connections">
            {(data.channels ?? []).map((c) => (
              <article className="provider-card" key={c.id}>
                <div className="service-card-heading row">
                  <Radio size={18} />
                  <h3>{c.name}</h3>
                  <span className="tag">
                    {!c.enabled
                      ? '已停用'
                      : c.status === 'connected'
                        ? '✓ 发送已验证'
                        : c.status === 'authorized'
                          ? '✓ 应用授权已验证'
                          : '待发送验证'}
                  </span>
                </div>
                <div className="row service-card-actions">
                  <button className="secondary" onClick={() => setChannel({ ...c })}>
                    管理
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void act(c.id, () => api.saveChannel({ ...c, enabled: !c.enabled }))
                    }
                  >
                    {c.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    disabled={!c.enabled}
                    onClick={() => setSend({ id: c.id, text: '同舟渠道连接测试' })}
                  >
                    发送消息 / 测试
                  </button>
                  {c.kind === 'email' && (
                    <button
                      disabled={!!busy || !c.enabled}
                      onClick={() => void act(c.id, () => api.testEmail(c.id))}
                    >
                      验证 SMTP
                    </button>
                  )}
                  <button
                    onClick={() =>
                      setRule({
                        id: crypto.randomUUID(),
                        channelId: c.id,
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
                  <button
                    className="text-button danger"
                    onClick={() => destructive(c.id, () => api.deleteChannel(c.id))}
                  >
                    {armed === c.id ? '确认删除' : '删除'}
                  </button>
                </div>
              </article>
            ))}
          </div>
          {!(data.channels ?? []).length && !channel && (
            <div className="empty-state compact">
              <Radio size={28} />
              <h3>让会话进展及时送达</h3>
              <p>接入飞书、企业微信或钉钉，再为会话配置通知规则。</p>
            </div>
          )}
          {channel && (
            <Modal title="配置通知渠道" onClose={() => setChannel(null)}>
              <form
                className="connection-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('channel-save', async () => {
                    await api.saveChannel(channel);
                    setChannel(null);
                  });
                }}
              >
                <h3>配置 {channel.name}</h3>
                <p>通知目标只负责发送消息。远程查看和管理会话请使用“机器人”模块。</p>
                <label>
                  名称
                  <input
                    required
                    value={channel.name}
                    onChange={(e) => setChannel({ ...channel, name: e.target.value })}
                  />
                </label>
                {channel.kind === 'email' && (
                  <EmailFields channel={channel} onChange={setChannel} />
                )}
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
                    <p>机器人入站操作已移至独立的“机器人”页面。</p>
                  </>
                )}
                <div className="row">
                  <button className="primary" disabled={!!busy}>
                    保存
                  </button>
                  <button type="button" onClick={() => setChannel(null)}>
                    取消
                  </button>
                </div>
              </form>
            </Modal>
          )}
          {send && (
            <Modal title="发送渠道消息" onClose={() => setSend(null)}>
              <form
                className="connection-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(
                    'send',
                    async () => {
                      const result = await api.sendChannel(send.id, send.text);
                      if (result.status !== 'sent') throw new Error(result.error ?? '未确认发送');
                      setSend(null);
                    },
                    '✓ 平台已确认发送',
                  );
                }}
              >
                <label>
                  将发送到 {data.channels?.find((c) => c.id === send.id)?.name}
                  <textarea
                    required
                    maxLength={4000}
                    value={send.text}
                    onChange={(e) => setSend({ ...send, text: e.target.value })}
                  />
                </label>
                <div className="row">
                  <button className="primary" disabled={!!busy}>
                    发送此消息
                  </button>
                  <button type="button" onClick={() => setSend(null)}>
                    取消
                  </button>
                </div>
              </form>
            </Modal>
          )}
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
                <h3>通知规则</h3>
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
              通知规则 <span className="tag">{data.notificationRules?.length ?? 0}</span>
            </h2>
            <p>按会话选择触发条件；应用关闭时不会发送。</p>
          </div>
          {!(data.notificationRules ?? []).length && (
            <p className="empty-record">暂无通知规则，在渠道中选择“添加通知规则”即可开始。</p>
          )}
          {(data.notificationRules ?? []).map((r) => (
            <div className="connection-record notification-rule" key={r.id}>
              <div className="rule-detail">
                <strong>
                  {data.channels?.find((c) => c.id === r.channelId)?.name ?? '已删除渠道'}
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
                  onClick={() => void act(r.id, () => api.deleteNotificationRule(r.id))}
                >
                  删除规则
                </button>
              </div>
            </div>
          ))}
        </>
      )}
      {tab === 'records' && (
        <>
          <h3>认证记录</h3>
          <p>只记录认证状态，不显示密钥、设备令牌或 Cookie。</p>
          {[...(data.authEvents ?? [])]
            .reverse()
            .slice(0, 100)
            .map((e) => (
              <div className="connection-record" key={e.id}>
                {new Date(e.time).toLocaleString()} ·{' '}
                {data.providers.find((p) => p.id === e.providerId)?.name ??
                  data.connectors?.find((c) => c.id === e.providerId)?.name ??
                  e.providerId}{' '}
                · {e.phase}
              </div>
            ))}
          {!(data.authEvents ?? []).length && <p className="empty-record">暂无认证记录</p>}
          <h3 className="record-heading">发送记录</h3>
          {!(data.deliveries ?? []).length && <p className="empty-record">暂无发送记录</p>}
          {(data.deliveries ?? []).map((d) => (
            <div className="connection-record" key={d.id}>
              {new Date(d.time).toLocaleString()} ·{' '}
              {data.channels?.find((c) => c.id === d.channelId)?.name ?? '已删除渠道'} ·{' '}
              {
                {
                  sent: '✓ 已发送',
                  failed: '失败',
                  sending: '发送中',
                  unknown: '结果未知，未重发',
                }[d.status]
              }{' '}
              {d.error}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
