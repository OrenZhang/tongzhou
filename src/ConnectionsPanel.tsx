import { useState, type ReactNode } from 'react';
import { Modal } from './components';
import { EmailFields, RuleConditions, defaultSmtp } from './NotificationControls';
import { BotsPanel } from './BotsPanel';
import { WorkPlugins } from './WorkPlugins';
import { Globe2, Network, Radio, History, Bot } from 'lucide-react';
import type { Channel, Connector, NotificationRule, Snapshot, TongzhouAPI } from './shared/types';

export function ConnectionsPanel({
  api,
  data,
  refresh,
  children,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  refresh: () => Promise<void>;
  children?: ReactNode;
}) {
  const [tab, setTab] = useState<'models' | 'accounts' | 'channels' | 'bots' | 'records'>('models');
  const [connector, setConnector] = useState<(Connector & { secret?: string }) | null>(null);
  const [channel, setChannel] = useState<
    (Channel & { webhook?: string; signingSecret?: string; password?: string }) | null
  >(null);
  const [rule, setRule] = useState<NotificationRule | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [armed, setArmed] = useState('');
  const [send, setSend] = useState<{ id: string; text: string } | null>(null);
  const [login, setLogin] = useState<{
    id: string;
    url: string;
    code: string;
    expiresAt: number;
  } | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>, success = '已保存') => {
    setBusy(key);
    setNotice('');
    try {
      const result = await fn();
      setNotice(typeof result === 'string' ? result : success);
      await refresh();
    } catch (e) {
      setNotice(String(e));
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
        {(['models', 'accounts', 'channels', 'bots', 'records'] as const).map((name, i) => (
          <button
            className={tab === name ? 'active' : ''}
            aria-pressed={tab === name}
            key={name}
            onClick={() => setTab(name)}
          >
            {(() => {
              const Icon = [Network, Globe2, Radio, Bot, History][i];
              return <Icon size={15} />;
            })()}
            {['模型与订阅', '服务与浏览器', '渠道通知', '机器人', '认证与发送记录'][i]}
          </button>
        ))}
      </nav>
      {notice && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      {tab === 'models' && children}
      {tab === 'bots' && <BotsPanel data={data} api={api} refresh={refresh} />}
      {tab === 'accounts' && (
        <>
          <div className="collection-toolbar">
            <div>
              <h2>代码托管账号与浏览器</h2>
              <p>连接 GitHub、GitLab，用于克隆仓库、拉取和推送代码。项目可分别选择账号。</p>
            </div>
            <button className="secondary" onClick={() => void api.openModule('projects')}>
              项目与工作树
            </button>
          </div>
          <div className="row">
            {(['github', 'gitlab', 'browser'] as const).map((kind) => (
              <button
                className="secondary"
                key={kind}
                onClick={() => {
                  setNotice('');
                  setConnector({
                    id: crypto.randomUUID(),
                    name:
                      kind === 'browser' ? '浏览器账号' : kind === 'github' ? 'GitHub' : 'GitLab',
                    kind,
                    enabled: true,
                    baseUrl:
                      kind === 'github'
                        ? 'https://github.com'
                        : kind === 'gitlab'
                          ? 'https://gitlab.com'
                          : 'https://',
                  });
                }}
              >
                添加 {kind === 'browser' ? '浏览器账号' : kind === 'github' ? 'GitHub' : 'GitLab'}
              </button>
            ))}
          </div>
          <div className="provider-grid service-connections">
            {(data.connectors ?? []).map((c) => (
              <article className="provider-card" key={c.id}>
                <div className="row service-card-heading">
                  <h3>{c.name}</h3>
                  <span className="tag">
                    {!c.enabled
                      ? '已停用'
                      : c.status === 'connected'
                        ? '✓ 已验证' + (c.account ? ' · ' + c.account : '')
                        : c.kind === 'browser'
                          ? '独立登录态'
                          : c.status === 'error'
                            ? '验证失败'
                            : '未验证'}
                  </span>
                </div>
                <p>{c.baseUrl}</p>
                <div className="row service-card-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setNotice('');
                      setConnector({ ...c, secret: '' });
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
                  {c.kind !== 'browser' && (
                    <button
                      disabled={!!busy || !c.enabled}
                      onClick={() => void act(c.id, () => api.testConnector(c.id))}
                    >
                      验证账号
                    </button>
                  )}
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
                  {c.kind !== 'browser' && (
                    <button
                      disabled={!!busy || !c.enabled}
                      onClick={() =>
                        void act(
                          c.id,
                          async () => setLogin({ id: c.id, ...(await api.loginConnector(c.id)) }),
                          '请在官方页面完成设备授权',
                        )
                      }
                    >
                      {c.kind === 'gitlab' ? '浏览器授权' : '设备授权'}
                    </button>
                  )}
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
          {!(data.connectors ?? []).length && !connector && (
            <div className="empty-state compact">
              <Globe2 size={28} />
              <h3>连接你的服务账号</h3>
              <p>添加代码托管服务或独立浏览器账号，登录态分别保存。</p>
            </div>
          )}
          {connector && (
            <Modal
              title={
                connector.kind === 'browser'
                  ? '配置浏览器账号'
                  : `${connector.kind === 'github' ? 'GitHub' : 'GitLab'} 账号认证`
              }
              onClose={() => setConnector(null)}
            >
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
                {connector.kind !== 'browser' && (
                  <p>
                    授权用于仓库读写。保存后可在「项目与工作树」克隆仓库，或绑定现有项目进行拉取和推送。
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
                {connector.kind !== 'browser' && (
                  <label>
                    访问令牌（留空保留已存令牌）
                    <input
                      type="password"
                      autoComplete="off"
                      value={connector.secret ?? ''}
                      onChange={(e) => setConnector({ ...connector, secret: e.target.value })}
                    />
                  </label>
                )}
                {connector.kind !== 'browser' && (
                  <details>
                    <summary>
                      {connector.kind === 'github'
                        ? '使用 GitHub 设备授权'
                        : '使用 GitLab 浏览器授权'}
                    </summary>
                    <label>
                      OAuth App Client ID
                      <input
                        value={connector.clientId ?? ''}
                        onChange={(e) => setConnector({ ...connector, clientId: e.target.value })}
                      />
                    </label>
                  </details>
                )}
                {connector.kind === 'github' && (
                  <p>
                    访问令牌需授权目标仓库；推送需 Contents 读写权限。使用设备授权时填写已启用
                    Device Flow 的 OAuth App Client ID，保存后点击「设备授权」。
                  </p>
                )}
                {connector.kind === 'gitlab' && (
                  <p>
                    访问令牌需具备 read_repository / write_repository 和 read_user 权限。OAuth
                    公共应用的回调地址：http://127.0.0.1:17437/connector/callback。
                  </p>
                )}
                {connector.kind === 'browser' && (
                  <p>独立浏览器保存本站登录态，不读取系统浏览器 Cookie。</p>
                )}
                <div className="row">
                  <button className="primary" disabled={!!busy}>
                    保存
                  </button>
                  {connector.kind !== 'browser' && (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        void act('connector-test', async () => {
                          await api.saveConnector(connector);
                          const result = await api.testConnector(connector.id);
                          setConnector(null);
                          return result;
                        })
                      }
                    >
                      保存并验证
                    </button>
                  )}
                  <button type="button" onClick={() => setConnector(null)}>
                    取消
                  </button>
                </div>
              </form>
            </Modal>
          )}
          {login && (
            <div className="connection-form">
              <h3>账号授权</h3>
              <p>
                在{' '}
                <a href={login.url} target="_blank" rel="noreferrer">
                  {login.url}
                </a>
                {login.code ? (
                  <>
                    {' '}
                    输入 <strong>{login.code}</strong>
                  </>
                ) : (
                  ' 完成登录'
                )}
              </p>
              <p>
                授权后自动校验账号身份。到期时间：{new Date(login.expiresAt).toLocaleTimeString()}
              </p>
              <button
                onClick={() =>
                  void act(
                    login.id,
                    async () => {
                      await api.cancelConnectorLogin(login.id);
                      setLogin(null);
                    },
                    '已结束授权等待',
                  )
                }
              >
                关闭授权
              </button>
            </div>
          )}
          <WorkPlugins data={data} api={api} refresh={refresh} />
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
