import { useState, type ReactNode } from 'react';
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
  const [tab, setTab] = useState<'models' | 'accounts' | 'channels' | 'records'>('models');
  const [connector, setConnector] = useState<(Connector & { secret?: string }) | null>(null);
  const [channel, setChannel] = useState<
    (Channel & { webhook?: string; signingSecret?: string }) | null
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
  const [qr, setQr] = useState<{
    id: string;
    url: string;
    image: string;
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
      <div className="row connection-tabs">
        {(['models', 'accounts', 'channels', 'records'] as const).map((name, i) => (
          <button
            className={tab === name ? 'primary' : 'secondary'}
            key={name}
            onClick={() => setTab(name)}
          >
            {['模型与订阅', '服务与浏览器', '渠道通知', '认证与发送记录'][i]}
          </button>
        ))}
      </div>
      {notice && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      {tab === 'models' && children}
      {tab === 'accounts' && (
        <>
          <p>代码托管账号与模型订阅分别管理。独立浏览器保存本站登录态，不读取系统浏览器 Cookie。</p>
          <div className="row">
            {(['github', 'gitlab', 'browser'] as const).map((kind) => (
              <button
                className="secondary"
                key={kind}
                onClick={() =>
                  setConnector({
                    id: crypto.randomUUID(),
                    name: kind === 'browser' ? '浏览器账号' : kind,
                    kind,
                    enabled: true,
                    baseUrl:
                      kind === 'github'
                        ? 'https://github.com'
                        : kind === 'gitlab'
                          ? 'https://gitlab.com'
                          : 'https://',
                  })
                }
              >
                添加 {kind === 'browser' ? '浏览器账号' : kind}
              </button>
            ))}
          </div>
          <div className="provider-grid">
            {(data.connectors ?? []).map((c) => (
              <article className="provider-card" key={c.id}>
                <div className="row">
                  <h3>{c.name}</h3>
                  <span className="tag">
                    {!c.enabled
                      ? '已停用'
                      : c.status === 'connected'
                        ? '✓ 已验证 ' + c.account
                        : c.kind === 'browser'
                          ? '独立登录态'
                          : c.status === 'error'
                            ? '验证失败'
                            : '未验证'}
                  </span>
                </div>
                <p>{c.baseUrl}</p>
                <div className="row">
                  <button onClick={() => setConnector({ ...c, secret: '' })}>管理</button>
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
                    onClick={() =>
                      destructive('clear-' + c.id, () => api.clearBrowserProfile(c.id))
                    }
                  >
                    {armed === 'clear-' + c.id ? '确认清除登录态' : '清除登录态'}
                  </button>
                  <button onClick={() => destructive(c.id, () => api.deleteConnector(c.id))}>
                    {armed === c.id ? '确认删除账号及登录态' : '删除'}
                  </button>
                </div>
              </article>
            ))}
          </div>
          {connector && (
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
              <h3>配置 {connector.kind}</h3>
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
                <label>
                  OAuth App Client ID
                  <input
                    value={connector.clientId ?? ''}
                    onChange={(e) => setConnector({ ...connector, clientId: e.target.value })}
                  />
                </label>
              )}
              <p>
                GitHub 账号验证不代表 Copilot 模型权益。GitLab 支持访问令牌与 PKCE 浏览器授权。使用
                OAuth 时注册公共应用，回调地址设为 http://127.0.0.1:17437/connector/callback。
              </p>
              <div className="row">
                <button className="primary" disabled={!!busy}>
                  保存
                </button>
                <button type="button" onClick={() => setConnector(null)}>
                  取消
                </button>
              </div>
            </form>
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
        </>
      )}
      {tab === 'channels' && (
        <>
          <button
            className="primary"
            disabled={!!busy}
            onClick={() =>
              void act(
                'feishu-qr',
                async () => {
                  setQr(await api.onboardFeishu(crypto.randomUUID(), '飞书扫码账号'));
                },
                '请使用飞书扫描二维码，创建并授权机器人',
              )
            }
          >
            飞书扫码接入
          </button>
          {qr && (
            <div className="connection-form">
              <h3>飞书扫码授权</h3>
              {data.channelAuth?.find((a) => a.id === qr.id)?.phase === 'success' ? (
                <p>✓ 应用授权已验证。可以发送测试消息，或绑定会话以接收消息。</p>
              ) : (
                <>
                  <img width={256} height={256} src={qr.image} alt="飞书官方应用授权二维码" />
                  <p>
                    到期：{new Date(qr.expiresAt).toLocaleTimeString()} · 状态：
                    {data.channelAuth?.find((a) => a.id === qr.id)?.phase ?? '等待扫码'}
                  </p>
                </>
              )}
              <button
                onClick={() =>
                  void act(
                    qr.id,
                    async () => {
                      await api.cancelChannelLogin(qr.id);
                      setQr(null);
                    },
                    '已关闭授权',
                  )
                }
              >
                关闭
              </button>
            </div>
          )}
          <p>
            把任务完成、失败或等待批准发送到指定群。通知规则可绑定当前会话或全部会话；应用关闭时不会发送。
          </p>
          <div className="row">
            {(['feishu', 'wecom', 'dingtalk'] as const).map((kind, i) => (
              <button
                className="secondary"
                key={kind}
                onClick={() =>
                  setChannel({
                    id: crypto.randomUUID(),
                    name: ['飞书', '企业微信', '钉钉'][i],
                    kind,
                    enabled: true,
                  })
                }
              >
                添加 {['飞书', '企业微信', '钉钉'][i]}
              </button>
            ))}
          </div>
          <div className="provider-grid">
            {(data.channels ?? []).map((c) => (
              <article className="provider-card" key={c.id}>
                <h3>
                  {c.name}{' '}
                  <span className="tag">
                    {!c.enabled
                      ? '已停用'
                      : c.status === 'connected'
                        ? '✓ 发送已验证'
                        : c.status === 'authorized'
                          ? '✓ 应用授权已验证'
                          : '待发送验证'}
                  </span>
                </h3>
                <div className="row">
                  <button onClick={() => setChannel({ ...c })}>管理</button>
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
                  <button onClick={() => destructive(c.id, () => api.deleteChannel(c.id))}>
                    {armed === c.id ? '确认删除' : '删除'}
                  </button>
                </div>
              </article>
            ))}
          </div>
          {channel && (
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
              <p>飞书支持扫码应用和 Webhook；企业微信、钉钉目前使用官方群机器人 Webhook。</p>
              <label>
                名称
                <input
                  required
                  value={channel.name}
                  onChange={(e) => setChannel({ ...channel, name: e.target.value })}
                />
              </label>
              {channel.mode !== 'app' && (
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
              {channel.mode !== 'app' && channel.kind !== 'wecom' && (
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
                  <label>
                    <input
                      type="checkbox"
                      checked={channel.inbound ?? false}
                      onChange={(e) => setChannel({ ...channel, inbound: e.target.checked })}
                    />
                    接收渠道消息到会话
                  </label>
                  {channel.inbound && (
                    <>
                      <label>
                        绑定会话
                        <select
                          aria-label="绑定会话"
                          value={channel.sessionId ?? ''}
                          onChange={(e) =>
                            setChannel({ ...channel, sessionId: e.target.value || undefined })
                          }
                        >
                          <option value="">请选择会话</option>
                          {data.sessions
                            .filter((s) => !s.archived && !s.parentId)
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.title}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        发送人 open_id 白名单（逗号分隔）
                        <input
                          value={channel.allowedSenders?.join(',') ?? ''}
                          onChange={(e) =>
                            setChannel({
                              ...channel,
                              allowedSenders: e.target.value
                                .split(',')
                                .map((x) => x.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      </label>
                      <p>只有白名单内用户的文本消息会进入绑定会话；机器人消息不会触发回复。</p>
                    </>
                  )}
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
          )}
          {send && (
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
          )}
          {rule && (
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
                {(['completed', 'failed', 'approval'] as const).map((event, i) => (
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
                    {['完成', '失败', '等待批准'][i]}
                  </label>
                ))}
              </div>
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
          )}
          {(data.notificationRules ?? []).map((r) => (
            <div className="connection-record" key={r.id}>
              <span>
                {data.channels?.find((c) => c.id === r.channelId)?.name} ·{' '}
                {r.sessionId ? data.sessions.find((s) => s.id === r.sessionId)?.title : '全部会话'}{' '}
                · {r.once ? '仅一次' : '持续'} · {r.enabled ? '启用' : '停用'}
              </span>
              <button onClick={() => setRule(r)}>编辑</button>
              <button
                onClick={() =>
                  void act(r.id, () => api.saveNotificationRule({ ...r, enabled: !r.enabled }))
                }
              >
                切换启停
              </button>
              <button onClick={() => void act(r.id, () => api.deleteNotificationRule(r.id))}>
                删除规则
              </button>
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
          <h3>发送记录</h3>
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
