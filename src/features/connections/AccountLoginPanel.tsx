import { ArrowRight, CheckCircle2, Globe2, RefreshCw } from 'lucide-react';
import type {
  NativeAuthState,
  NativeEngine,
  CodexAuthState,
  CodexLoginMethod,
} from '../../shared/types';
import { AuthBadge, Mark, Spinner } from '../../components/components';
import type { Dispatch, SetStateAction } from 'react';

interface Props {
  codex: CodexAuthState | null;
  authPending: boolean;
  startLogin: (method: CodexLoginMethod) => Promise<void | undefined>;
  perform: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  setCodex: Dispatch<SetStateAction<CodexAuthState | null>>;
  api: Window['tongzhou'];
  authPanel: 'codex' | NativeEngine | null;
  authProviderId: string | undefined;
  setNotice: Dispatch<SetStateAction<string>>;
  busy: boolean;
  nativeAccounts: Partial<Record<NativeEngine, NativeAuthState>>;
  nativeRegions: Record<NativeEngine, 'cn' | 'global'>;
  setNativeRegions: Dispatch<SetStateAction<Record<NativeEngine, 'cn' | 'global'>>>;
  only?: 'codex' | NativeEngine;
}
export function AccountLoginPanel({
  codex,
  authPending,
  startLogin,
  perform,
  setCodex,
  api,
  authPanel,
  authProviderId,
  setNotice,
  busy,
  nativeAccounts,
  nativeRegions,
  setNativeRegions,
  only,
}: Props) {
  return (
    <>
      {(!only || only === 'codex') && (
        <section className="settings-card">
          <div className="settings-card-title">
            <Mark small />
            <div>
              <h3>OpenAI / ChatGPT 登录</h3>
              <p>使用独立的 Codex 配置目录，不改写你已有的 Codex 配置。</p>
            </div>
          </div>
          <div className="account-status">
            <AuthBadge
              connected={codex ? !!codex.account : undefined}
              pending={authPending}
              error={!!codex?.error}
            />
            {codex
              ? codex.account || (codex.available ? 'Codex 可用，尚未登录' : 'Codex 未就绪')
              : '正在检查账号状态…'}
            {codex?.plan && <small>{codex.plan}</small>}
            {codex?.error && <small>{codex.error}</small>}
          </div>
          <div className="row">
            <button
              className="primary"
              disabled={authPending || !!codex?.account}
              onClick={() => startLogin('browser')}
            >
              ChatGPT 浏览器登录
              <ArrowRight size={15} />
            </button>
            <button
              className="secondary"
              disabled={authPending || !!codex?.account}
              onClick={() => startLogin('device')}
            >
              设备码登录
            </button>
            <button
              className="secondary"
              onClick={() =>
                perform(async () =>
                  setCodex(await api.codexStatus(authPanel ? authProviderId : undefined)),
                )
              }
            >
              <RefreshCw size={14} />
              刷新状态
            </button>
            {codex?.account && !authPending && (
              <button
                className="text-button danger"
                onClick={() =>
                  perform(async () => {
                    await api.codexLogout(authPanel ? authProviderId : undefined);
                    setCodex(await api.codexStatus(authPanel ? authProviderId : undefined));
                  })
                }
              >
                退出登录
              </button>
            )}
          </div>
          {codex?.login && (
            <div className={'auth-progress ' + codex.login.phase} aria-live="polite">
              {codex.login.phase === 'starting' && (
                <p>
                  <Spinner /> 正在创建授权请求…
                </p>
              )}
              {codex.login.phase === 'checking' && (
                <p>
                  <Spinner /> 正在确认账号与授权结果…
                </p>
              )}
              {codex.login.phase === 'waiting' && (
                <>
                  <strong>
                    {codex.login.method === 'device' ? '输入设备码完成授权' : '等待浏览器授权完成'}
                  </strong>
                  <p>
                    {codex.login.method === 'device'
                      ? '打开官方授权页面，登录你的 ChatGPT 账号并输入以下一次性设备码。'
                      : '在系统浏览器中登录 ChatGPT 并完成授权；同舟会自动更新状态。若浏览器回调失败，可以取消后改用设备码登录。'}
                  </p>
                  {codex.login.userCode && (
                    <div className="device-code-row">
                      <code aria-label="设备授权码">{codex.login.userCode}</code>
                      <button
                        className="secondary"
                        onClick={() =>
                          perform(async () => {
                            await api.codexLoginCopyCode(authPanel ? authProviderId : undefined);
                            setNotice('设备码已复制');
                          })
                        }
                      >
                        复制设备码
                      </button>
                    </div>
                  )}
                  {codex.login.method === 'device' && (
                    <p>设备码登录需要在 ChatGPT 安全设置或工作区权限中启用。</p>
                  )}
                  {codex.login.error && <p role="alert">{codex.login.error}</p>}
                  {codex.login.method === 'browser' && (
                    <div className="auth-recovery">
                      <p>
                        如果网页出现 Route Error / Invalid content
                        type，表示授权网页收到了异常响应。可以重新发起，或改用设备码；旧页面重试不会创建新的授权。
                      </p>
                      <div className="row">
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            perform(() => api.codexLoginRetry('device', authProviderId))
                          }
                        >
                          改用设备码登录
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            perform(() => api.codexLoginRetry('browser', authProviderId))
                          }
                        >
                          重新发起浏览器授权
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="row">
                    <button
                      className="primary"
                      onClick={() =>
                        perform(() => api.codexLoginOpen(authPanel ? authProviderId : undefined))
                      }
                    >
                      打开授权页面
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        perform(() => api.codexLoginCancel(authPanel ? authProviderId : undefined))
                      }
                    >
                      取消授权
                    </button>
                  </div>
                </>
              )}
              {codex.login.phase === 'success' && (
                <p>
                  <CheckCircle2 size={16} /> 授权成功，已连接 {codex.account}
                  。模型列表将自动更新。
                </p>
              )}
              {codex.login.phase === 'error' && (
                <p role="alert">授权失败：{codex.login.error}。可重新授权或切换登录方式。</p>
              )}
              {codex.login.phase === 'cancelled' && <p>已取消本次授权，可以重新选择登录方式。</p>}
            </div>
          )}
          <p className="footnote">
            这两种方式均使用 ChatGPT 账号授权给内置 Codex，成功后选择“OpenAI · ChatGPT”连接。API Key
            连接仍需单独配置。
          </p>
        </section>
      )}
      {(['kimi', 'minimax'] as const)
        .filter((engine) => !only || engine === only)
        .map((engine) => {
          const state = nativeAccounts[engine];
          const pending = !!state && ['starting', 'waiting', 'checking'].includes(state.phase);
          const label = engine === 'kimi' ? 'Kimi Code' : 'MiniMax Code';
          return (
            <section className="settings-card" key={engine} aria-label={`${label} 账号`}>
              <div className="settings-card-title">
                <Globe2 size={23} />
                <div>
                  <h3>{label} 账号授权</h3>
                  <p>登录后可在同一会话中切换模型，也可分配给子 Agent。</p>
                </div>
              </div>
              <div className="account-status">
                <AuthBadge
                  connected={state?.authenticated}
                  pending={pending}
                  error={!!state?.error}
                />
                {state ? (state.authenticated ? '账号已授权' : '尚未登录') : '正在检查账号状态…'}
              </div>
              <div className="row">
                <select
                  aria-label={`${label} 账号地区`}
                  disabled={pending || state?.authenticated}
                  value={nativeRegions[engine]}
                  onChange={(e) =>
                    setNativeRegions((previous) => ({
                      ...previous,
                      [engine]: e.target.value as 'cn' | 'global',
                    }))
                  }
                >
                  <option value="cn">国内账号</option>
                  <option value="global">国际账号</option>
                </select>
                <button
                  className="primary"
                  disabled={pending || state?.authenticated}
                  onClick={() =>
                    perform(() => api.nativeLogin(engine, nativeRegions[engine], authProviderId))
                  }
                >
                  登录 {label}
                  <ArrowRight size={15} />
                </button>
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={() =>
                    perform(() => api.nativeStatus(engine, authPanel ? authProviderId : undefined))
                  }
                >
                  <RefreshCw size={14} />
                  刷新状态
                </button>
                {state?.authenticated && !pending && (
                  <button
                    className="text-button danger"
                    onClick={() =>
                      perform(() =>
                        api.nativeLogout(engine, authPanel ? authProviderId : undefined),
                      )
                    }
                  >
                    退出登录
                  </button>
                )}
              </div>
              {pending && (
                <div className="auth-progress waiting" aria-live="polite">
                  <p>
                    {state.phase === 'starting'
                      ? '正在创建授权请求…'
                      : state.phase === 'checking'
                        ? '正在验证账号并同步模型…'
                        : '请在官方授权页面登录账号并确认授权。'}
                  </p>
                  {state.userCode && (
                    <div className="device-code-row">
                      <code aria-label={`${label} 设备码`}>{state.userCode}</code>
                      <button
                        className="secondary"
                        onClick={() =>
                          perform(() =>
                            api.nativeCopyCode(engine, authPanel ? authProviderId : undefined),
                          )
                        }
                      >
                        复制设备码
                      </button>
                    </div>
                  )}
                  <div className="row">
                    {state.url && (
                      <button
                        className="primary"
                        onClick={() =>
                          perform(() =>
                            api.nativeOpen(engine, authPanel ? authProviderId : undefined),
                          )
                        }
                      >
                        打开授权页面
                      </button>
                    )}
                    <button
                      className="text-button"
                      onClick={() =>
                        perform(() =>
                          api.nativeCancel(engine, authPanel ? authProviderId : undefined),
                        )
                      }
                    >
                      取消授权
                    </button>
                  </div>
                </div>
              )}
              {state?.phase === 'success' && (
                <div className="auth-progress success">
                  授权成功，已同步模型列表。请选择“{engine === 'kimi' ? 'Kimi' : 'MiniMax'} ·
                  账号授权”连接开始聊天。
                </div>
              )}
              {state?.phase === 'cancelled' && <p className="muted">本次授权已取消。</p>}
              {state?.error && (
                <div className="auth-progress error" role="alert">
                  {state.error}
                </div>
              )}
              <p className="footnote">
                使用内置官方客户端管理登录与续期，凭据保存在同舟独立目录。任务统一由 Codex
                核心执行。账号套餐与 API Key 分开配置；API / 套餐 Key 可在“模型”中添加。
              </p>
            </section>
          );
        })}
    </>
  );
}
