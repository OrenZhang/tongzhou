import { useEffect, useRef, useState } from 'react';
import './bots.css';
import { BotSettingsPanel } from './BotSettingsPanel';
import {
  ArrowUpRight,
  Building2,
  ChevronRight,
  MessageCircle,
  MoreHorizontal,
  QrCode,
  KeyRound,
  Send,
  Zap,
} from 'lucide-react';
import { Modal } from '../../components/components';
import { MultiValueInput } from '../../components/controls/MultiValueInput';
import type { BotConfig, Snapshot, TongzhouAPI } from '../../shared/types';
const labels = { feishu: '飞书', wecom: '企业微信', dingtalk: '钉钉', weixin: '微信 ClawBot' };
const platforms = [
  {
    kind: 'weixin',
    title: '微信',
    detail: '通过 ClawBot 私聊，发起任务并接收结果',
    icon: MessageCircle,
    method: '扫码接入',
  },
  {
    kind: 'feishu',
    title: '飞书',
    detail: '在飞书中查看进度，管理工作会话',
    icon: Send,
    method: '扫码接入',
  },
  {
    kind: 'wecom',
    title: '企业微信',
    detail: '连接智能机器人，在企业微信中协作',
    icon: Building2,
    method: '扫码接入',
  },
  {
    kind: 'dingtalk',
    title: '钉钉',
    detail: '连接应用机器人，在钉钉中处理任务',
    icon: Zap,
    method: '扫码接入',
  },
] as const;
function PlatformIcon({ kind }: { kind: BotConfig['kind'] }) {
  const Icon = platforms.find((platform) => platform.kind === kind)!.icon;
  return (
    <span className="bot-platform-icon" data-platform={kind}>
      <Icon size={21} strokeWidth={1.7} aria-hidden="true" />
    </span>
  );
}
type QrPlatform = BotConfig['kind'];
const authLabels: Record<string, string> = {
  waiting: '等待扫码授权',
  success: '授权成功',
  expired: '二维码已过期',
  cancelled: '授权已取消',
  error: '授权未完成，请重新获取二维码或手动配置',
  scanned: '已扫码，请在微信中确认',
  verify_required: '请输入手机微信显示的数字验证码',
  verify_invalid: '验证码不匹配，请重新输入手机微信显示的数字',
  verifying: '正在验证',
  verify_blocked: '验证码错误次数过多，请稍后重新扫码',
  already_bound: '此账号已绑定，请管理已有机器人；若仍无法连接，请重新扫码',
};
const statuses = {
  connecting: '连接中',
  listening: '正在监听',
  connected: '已连接',
  error: '连接异常',
};
export function BotsPage({
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
  const [qr, setQr] = useState<{
    id: string;
    image: string;
    expiresAt: number;
    kind: QrPlatform;
  } | null>(null);
  const [setup, setSetup] = useState<QrPlatform | null>(null);
  const [setupId, setSetupId] = useState<string>();
  const qrRequest = useRef<string | null>(null);
  const [setupError, setSetupError] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [verificationError, setVerificationError] = useState('');
  const authPhase = data.channelAuth?.find((a) => a.id === qr?.id)?.phase ?? 'waiting';
  useEffect(
    () => () => {
      if (qrRequest.current) void api.cancelBotLogin(qrRequest.current).catch(() => {});
      qrRequest.current = null;
    },
    [api],
  );
  const closeQr = () => {
    if (qrRequest.current)
      void api.cancelBotLogin(qrRequest.current).catch((e) => setNotice(String(e)));
    qrRequest.current = null;
    setQr(null);
  };
  const startQr = async (kind: QrPlatform, existingId?: string) => {
    closeQr();
    setSetup(kind);
    setSetupId(existingId);
    setBusy(true);
    setSetupError('');
    setVerifyCode('');
    setVerificationError('');
    const id = existingId ?? crypto.randomUUID();
    qrRequest.current = id;
    try {
      const result = await api.onboardBot(id, labels[kind] + '机器人', kind);
      if (qrRequest.current !== id) {
        await api.cancelBotLogin(id);
        return;
      }
      setQr({ ...result, kind });
      setSetup(null);
      await refresh();
    } catch (e) {
      if (qrRequest.current === id) setSetupError(String(e));
    } finally {
      setBusy(false);
    }
  };
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
      allowedSenders: [],
      allowedChats: [],
    });
  return (
    <main className="page bots-panel">
      <header className="page-heading">
        <div>
          <h1>机器人</h1>
          <p>把同舟接到常用聊天工具，随时发起任务、接收结果。</p>
        </div>
      </header>
      {notice && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      <div className="bot-workspace">
        <div className="bot-connections">
          {!!data.bots?.length && (
            <section className="bot-section" aria-label="已添加的机器人">
              <div className="bot-section-heading">
                <h2>已添加</h2>
                <span>{data.bots.length}</span>
              </div>
              <div className="bot-connection-list">
                {data.bots.map((b) => (
                  <article className="bot-connection-row" key={b.id}>
                    <PlatformIcon kind={b.kind} />
                    <div className="bot-connection-copy">
                      <div className="bot-connection-title">
                        <h3 title={b.name}>{b.name}</h3>
                        <span
                          className="bot-connection-status"
                          data-status={b.status ?? 'connecting'}
                        >
                          {statuses[b.status ?? 'connecting']}
                        </span>
                      </div>
                      <p>
                        {labels[b.kind]} · {b.allowedSenders.length} 位允许用户
                      </p>
                      {b.error && (
                        <p className="bot-connection-error" role="status">
                          {b.error}
                        </p>
                      )}
                    </div>
                    <div className="bot-row-actions">
                      <button
                        className="bot-manage-button"
                        disabled={busy}
                        onClick={() => setEdit({ ...b, secret: '' })}
                      >
                        管理机器人
                      </button>
                      <details
                        className="bot-actions-menu"
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                            event.currentTarget.open = false;
                            setArmed('');
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.currentTarget.open = false;
                            event.currentTarget.querySelector('summary')?.focus();
                            setArmed('');
                          }
                        }}
                      >
                        <summary aria-label={`更多操作：${b.name}`} title="更多操作">
                          <MoreHorizontal size={18} />
                        </summary>
                        <div className="bot-actions-popover">
                          {b.kind === 'weixin' && (
                            <button disabled={busy} onClick={() => void startQr('weixin', b.id)}>
                              重新扫码
                            </button>
                          )}
                          <button
                            disabled={busy}
                            onClick={() => void act(() => api.restartBot(b.id), '已重新连接')}
                          >
                            重新连接
                          </button>
                          <button
                            className="bot-delete-action"
                            disabled={busy}
                            onClick={() => {
                              if (armed !== b.id) setArmed(b.id);
                              else void act(() => api.deleteBot(b.id), '已删除机器人');
                            }}
                          >
                            {armed === b.id ? '确认删除' : '删除机器人'}
                          </button>
                        </div>
                      </details>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          <section className="bot-section" aria-label="添加机器人连接">
            <div className="bot-section-heading">
              <h2>{data.bots?.length ? '添加连接' : '选择一个聊天平台'}</h2>
            </div>
            <div className="bot-platform-list">
              {platforms.map(({ kind, title, detail, method }) => (
                <button
                  className="bot-platform-row"
                  aria-label={`${labels[kind]}机器人`}
                  key={kind}
                  disabled={busy}
                  onClick={() => {
                    setSetupError('');
                    setSetupId(undefined);
                    setSetup(kind);
                  }}
                >
                  <PlatformIcon kind={kind} />
                  <span className="bot-platform-copy">
                    <strong>
                      {title}
                      {kind === 'weixin' && <span className="bot-platform-tag">ClawBot</span>}
                    </strong>
                    <small>{detail}</small>
                  </span>
                  <span className="bot-platform-action">
                    {method}
                    <ArrowUpRight size={15} />
                  </span>
                  <ChevronRight className="bot-platform-chevron" size={17} />
                </button>
              ))}
            </div>
            <p className="bot-availability-note">同舟运行时自动保持连接。</p>
          </section>
        </div>
        <BotSettingsPanel data={data} api={api} refresh={refresh} />
      </div>
      {setup && (
        <Modal
          compact
          title={`添加${labels[setup]}机器人`}
          onClose={() => {
            if (!busy) setSetup(null);
          }}
        >
          <div className="modal-content connection-form">
            <p>选择接入方式，授权后设置允许用户即可连接。</p>
            {setupError && (
              <p role="alert" className="info-strip">
                {setupError}
              </p>
            )}
            <div className="setup-methods">
              <button
                className="setup-method"
                disabled={busy}
                onClick={() => void startQr(setup, setupId)}
              >
                <QrCode size={22} />
                <span>
                  <strong>{busy ? '正在获取二维码…' : '扫码接入'}</strong>
                  <small>
                    使用{setup === 'weixin' ? '手机微信' : labels[setup]}扫描二维码并确认连接。
                  </small>
                </span>
              </button>
              {setup !== 'weixin' && (
                <button
                  className="setup-method"
                  disabled={busy}
                  onClick={() => {
                    setSetup(null);
                    create(setup);
                  }}
                >
                  <KeyRound size={22} />
                  <span>
                    <strong>手动配置</strong>
                    <small>
                      {setup === 'wecom'
                        ? '已有智能机器人，填写 Bot ID 和 Secret。'
                        : setup === 'dingtalk'
                          ? '已有钉钉应用，填写 Client ID 和 Client Secret。'
                          : '已有飞书或 Lark 应用，填写 App ID 和应用密钥。'}
                    </small>
                  </span>
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {qr && (
        <Modal compact title={`${labels[qr.kind]}机器人扫码授权`} onClose={closeQr}>
          <div className="modal-content connection-form bot-qr-form">
            {authPhase === 'success' ? (
              <>
                <p>✓ 机器人授权已保存。模型和会话范围由右侧通用设置统一管理。</p>
                <button
                  className="primary"
                  onClick={() => {
                    const b = data.bots?.find((b) => b.id === qr.id);
                    if (b) {
                      setEdit(b);
                      closeQr();
                    }
                  }}
                >
                  配置机器人
                </button>
              </>
            ) : (
              <>
                {!['expired', 'error', 'cancelled', 'verify_blocked', 'already_bound'].includes(
                  authPhase,
                ) && (
                  <img
                    width={224}
                    height={224}
                    src={qr.image}
                    alt={`${labels[qr.kind]}机器人授权二维码`}
                  />
                )}
                <p role="status">
                  {authPhase === 'error' && qr.kind === 'weixin'
                    ? '授权未完成，请重新扫码'
                    : (authLabels[authPhase] ?? '等待扫码授权')}{' '}
                  · {new Date(qr.expiresAt).toLocaleTimeString()} 到期
                </p>
                {qr.kind === 'weixin' &&
                  ['verify_required', 'verify_invalid'].includes(authPhase) && (
                    <form
                      className="bot-verify-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        setVerificationError('');
                        setBusy(true);
                        void api
                          .verifyBotLogin(qr.id, verifyCode.trim())
                          .then(() => {
                            setVerifyCode('');
                            return refresh();
                          })
                          .catch(() => setVerificationError('验证码提交失败，请检查后重试'))
                          .finally(() => setBusy(false));
                      }}
                    >
                      <label>
                        微信验证码
                        <input
                          aria-label="微信验证码"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          pattern="[0-9]{4,12}"
                          maxLength={12}
                          required
                          value={verifyCode}
                          onChange={(event) => setVerifyCode(event.target.value)}
                        />
                      </label>
                      {verificationError && <p role="alert">{verificationError}</p>}
                      <button className="primary" disabled={busy}>
                        确认验证码
                      </button>
                    </form>
                  )}
                <div className="row">
                  <button disabled={busy} onClick={() => void startQr(qr.kind, qr.id)}>
                    重新获取二维码
                  </button>
                  {qr.kind !== 'weixin' && (
                    <button
                      onClick={() => {
                        closeQr();
                        create(qr.kind);
                      }}
                    >
                      手动配置
                    </button>
                  )}
                </div>
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
                {edit.kind === 'wecom' || edit.kind === 'weixin' ? 'Bot ID' : 'App / Client ID'}
                <input
                  required
                  readOnly={edit.kind === 'weixin'}
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
            {edit.kind !== 'weixin' && (
              <label>
                应用密钥（留空保留）
                <input
                  type="password"
                  autoComplete="new-password"
                  value={edit.secret ?? ''}
                  onChange={(e) => setEdit({ ...edit, secret: e.target.value })}
                />
              </label>
            )}
            <label>
              允许用户 ID
              <MultiValueInput
                label="允许用户 ID"
                value={edit.allowedSenders}
                onChange={(allowedSenders) => setEdit({ ...edit, allowedSenders })}
              />
            </label>
            {edit.kind !== 'weixin' && (
              <label>
                允许群 ID（空白仅允许私聊）
                <MultiValueInput
                  label="允许群 ID"
                  value={edit.allowedChats}
                  onChange={(allowedChats) => setEdit({ ...edit, allowedChats })}
                />
              </label>
            )}
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
    </main>
  );
}
