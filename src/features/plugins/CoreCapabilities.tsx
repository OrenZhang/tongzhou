import { t as tr, localize as localized, getLocale } from '../../shared/i18n';
import { useEffect, useState } from 'react';
import { Copy, Monitor, Settings2, Terminal, ShieldCheck, Square, ArrowRight } from 'lucide-react';
import { Spinner } from '../../components/components';
import { errorMessage } from '../../lib/feedback';
import { ClientCapabilityCatalog } from './ClientCapabilityCatalog';
import { ComputerSystemPermissions } from './ComputerSystemPermissions';
import type { ComputerStatus, Snapshot, TongzhouAPI } from '../../shared/types';

type Operation = { pending?: string; message?: string; error?: boolean; desired?: boolean };
type Capability = 'computer' | 'management';
const examples = localized({
  computer: '帮我查看当前打开的窗口，先告诉我有哪些窗口，再按我的要求操作。',
  management: '帮我看看CoSail有哪些会话、已启用的插件和 Agent。先列出来，不要修改。',
});

export function CoreCapabilities({
  api,
  data,
  refresh,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  refresh: () => Promise<void>;
}) {
  const [status, setStatus] = useState<ComputerStatus>();
  const [operations, setOperations] = useState<Record<Capability, Operation>>({
    computer: {},
    management: {},
  });
  const running = data.runs.filter((r) => r.status === 'running').length;
  useEffect(() => {
    let live = true;
    void api.computerStatus().then(
      (next) => {
        if (live) setStatus(next);
      },
      (error) => {
        if (live)
          setOperations((old) => ({
            ...old,
            computer: { error: true, message: errorMessage(error) },
          }));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (status?.platform !== 'darwin') return;
    let live = true;
    const refreshPermissions = () => {
      void api.computerStatus().then(
        (next) => {
          if (live) setStatus(next);
        },
        () => {},
      );
    };
    window.addEventListener('focus', refreshPermissions);
    return () => {
      live = false;
      window.removeEventListener('focus', refreshPermissions);
    };
  }, [api, status?.platform]);
  const act = async (
    key: Capability,
    pending: string,
    fn: () => Promise<string>,
    desired?: boolean,
  ) => {
    setOperations((old) => ({ ...old, [key]: { pending, desired } }));
    try {
      const message = await fn();
      await refresh();
      setOperations((old) => ({ ...old, [key]: { message } }));
    } catch (error) {
      setOperations((old) => ({ ...old, [key]: { error: true, message: errorMessage(error) } }));
    }
  };
  const enabled = (key: Capability) => data.capabilities?.[key] ?? key === 'management';
  const toggle = (key: Capability) => (
    <div className="capability-toggle">
      <span>
        {operations[key].pending === '正在保存开关…'
          ? tr('保存中…')
          : enabled(key)
            ? tr('已启用')
            : tr('已停用')}
      </span>
      <label className="switch-control">
        <input
          type="checkbox"
          role="switch"
          aria-label={key === 'computer' ? tr('启用电脑控制') : tr('启用客户端管理')}
          checked={operations[key].desired ?? enabled(key)}
          disabled={
            !!operations[key].pending || (key === 'computer' && !!status && !status.supported)
          }
          onChange={(event) => {
            const next = event.target.checked;
            void act(
              key,
              '正在保存开关…',
              async () => {
                await api.setCapability(key, next);
                return next
                  ? tr('已启用。Agent 从下一轮对话起可使用此能力。')
                  : tr('已停用，后续工具调用将不再使用此能力。');
              },
              next,
            );
          }}
        />
        <span aria-hidden="true" />
      </label>
    </div>
  );
  const feedback = (key: Capability) => {
    const op = operations[key];
    return op.pending || op.message ? (
      <p
        className={'capability-feedback ' + (op.error ? 'is-error' : '')}
        role={op.error ? 'alert' : 'status'}
        aria-live="polite"
      >
        {op.pending && <Spinner />}
        {tr(op.pending || op.message || '')}
      </p>
    ) : null;
  };
  const example = (key: Capability) => (
    <div className="capability-example">
      <div>
        <span className="muted">{tr('在会话中试着说')}</span>
        <p>{examples[key]}</p>
      </div>
      <button
        className="icon-button"
        aria-label={key === 'computer' ? tr('复制电脑控制示例') : tr('复制客户端管理示例')}
        title={tr('复制提问示例')}
        disabled={!!operations[key].pending}
        onClick={() =>
          void act(key, tr('正在复制…'), async () => {
            await api.copyText(examples[key]);
            return tr('已复制示例。前往会话粘贴并发送即可。');
          })
        }
      >
        <Copy size={15} />
      </button>
    </div>
  );
  const diagnostic = status?.supported ? status.diagnostic : undefined;
  const unsupported = !!status && !status.supported;
  const computerBusy = !!operations.computer.pending;
  const testing = operations.computer.pending === '正在检测，请保持测试窗口可见…';
  const permissionLabel =
    status?.platform === 'win32'
      ? tr('Windows 无需单独授权，仍需检测实际功能。')
      : status?.platform === 'darwin'
        ? tr('屏幕录制：{0} · 辅助功能：{1}', [
            status.screen === 'granted' ? tr('已授权') : tr('待授权'),
            status.accessibility ? tr('已授权') : tr('待授权'),
          ])
        : status
          ? status.platform === 'linux'
            ? status.supported
              ? tr('Linux（X11）无需单独授权，仍需检测实际功能。')
              : tr('Linux 暂不支持电脑控制（需要 X11 / XWayland 显示环境）。')
            : tr('当前系统暂不支持电脑控制。')
          : tr('系统状态尚未加载，可点击刷新。');
  return (
    <div className="core-capabilities">
      <section className="settings-card capability-card" aria-label={tr('电脑控制能力')}>
        <div className="capability-heading">
          <div className="settings-card-title">
            <Monitor />
            <div>
              <h3>{tr('电脑控制')}</h3>
              <p>{tr('让 Agent 查看和操作电脑上的窗口。')}</p>
            </div>
          </div>
          {toggle('computer')}
        </div>
        <p className="capability-description">
          {unsupported
            ? tr('当前系统暂不支持此能力。可以继续在会话中使用项目文件、终端和客户端管理。')
            : tr(
                '可以截图、点击、输入文字、使用快捷键。开启后，在会话里告诉 Agent 要操作哪个窗口、完成什么任务。',
              )}
        </p>
        {!unsupported && example('computer')}
        {status && <ComputerSystemPermissions api={api} status={status} onStatus={setStatus} />}
        {!unsupported && (
          <div
            className={
              'capability-diagnostic ' +
              (diagnostic ? (diagnostic.ok ? 'is-success' : 'is-error') : '')
            }
            aria-live="polite"
          >
            <strong>
              {testing
                ? tr('正在检测电脑控制')
                : diagnostic
                  ? diagnostic.ok
                    ? tr('上次检测通过')
                    : tr('上次检测未通过')
                  : tr('尚未检测电脑控制')}
            </strong>
            <p>
              {testing
                ? tr('正在验证窗口识别、截图和中文输入。测试只操作新建的本地窗口，不会发送给模型。')
                : diagnostic
                  ? errorMessage(diagnostic.detail)
                  : tr('启用开关不代表系统功能已就绪。可先运行一次本机检测，不需要连接模型。')}
            </p>
            {!testing && diagnostic && (
              <small>
                {tr('检测时间：')}
                {new Date(diagnostic.time).toLocaleString(getLocale())}
                {tr(' · 结果仅代表当时的本机状态')}
              </small>
            )}
          </div>
        )}
        <div className="capability-actions">
          {!unsupported && (
            <button
              className="secondary"
              disabled={computerBusy || !status?.supported || running > 0}
              onClick={() =>
                void act('computer', '正在检测，请保持测试窗口可见…', async () => {
                  const next = await api.computerSelfTest();
                  setStatus(next);
                  if (!next.diagnostic?.ok)
                    throw new Error(
                      errorMessage(next.diagnostic?.detail ?? tr('检测未完成，请重试。')),
                    );
                  return tr('检测通过，可以返回会话使用电脑控制。');
                })
              }
            >
              {testing ? <Spinner /> : <Monitor size={15} />}
              {testing
                ? tr('检测中…')
                : diagnostic && !diagnostic.ok
                  ? tr('重新检测')
                  : tr('检测电脑控制')}
            </button>
          )}
          <button
            className="text-button"
            disabled={computerBusy}
            onClick={() =>
              void act('computer', '正在检查系统状态…', async () => {
                const next = await (status?.platform === 'darwin'
                  ? api.computerPermission()
                  : api.computerStatus());
                setStatus(next);
                return next.supported
                  ? tr('系统状态已刷新。是否可以截图和输入，请以电脑控制检测结果为准。')
                  : tr('系统状态已刷新。当前系统暂不支持电脑控制。');
              })
            }
          >
            <ShieldCheck size={15} />
            {status?.platform === 'darwin' ? tr('检查系统权限') : tr('刷新系统状态')}
          </button>
          {running > 0 && (
            <button
              className="text-button danger"
              disabled={computerBusy}
              onClick={() =>
                void act('computer', tr('正在停止任务…'), async () => {
                  await api.emergencyStop();
                  return tr('已请求停止全部运行任务。');
                })
              }
            >
              <Square size={15} />
              {tr('停止全部任务（')}
              {running}）
            </button>
          )}
        </div>
        <p className="capability-note">
          {running > 0 ? tr('有任务正在运行，结束后可以进行本机检测。') : tr('当前没有运行任务。')}{' '}
          {permissionLabel}
        </p>
        {feedback('computer')}
        <details className="capability-details">
          <summary>{tr('使用条件与操作权限')}</summary>
          <p>
            {tr(
              '需要支持图片与工具调用的模型。会话中使用的截图会发送给当前模型服务；操作遵循会话权限设置。窗口移动后需要重新截图。',
            )}
          </p>
          <p>
            {status?.emergencyShortcut
              ? tr('紧急停止快捷键：{0} + Esc。', [
                  status.platform === 'darwin' ? '⌘ + Option' : 'Ctrl + Alt',
                ])
              : tr('紧急停止快捷键不可用，运行时请使用停止任务按钮。')}
          </p>
        </details>
      </section>
      <section className="settings-card capability-card" aria-label={tr('客户端管理能力')}>
        <div className="capability-heading">
          <div className="settings-card-title">
            <Settings2 />
            <div>
              <h3>{tr('客户端管理')}</h3>
              <p>{tr('在会话里管理CoSail自己的功能。')}</p>
            </div>
          </div>
          {toggle('management')}
        </div>
        <p className="capability-description">
          {tr(
            '让 Agent 查询和操作CoSail各模块：会话、模型连接、认证状态、机器人、通知、插件、Skills、项目与外观。 新功能注册后自动接入。关闭后，仍可手动使用这些页面。',
          )}
        </p>
        {example('management')}
        <div className="capability-actions">
          <button
            className="secondary"
            disabled={!!operations.management.pending}
            onClick={() =>
              void act('management', tr('正在打开会话…'), async () => {
                await api.openModule('workspace');
                return tr('已返回会话');
              })
            }
          >
            {tr('前往会话')}
            <ArrowRight size={15} />
          </button>
          <span className="capability-note">{tr('需要模型支持工具调用；修改遵循会话权限。')}</span>
        </div>
        {feedback('management')}
        <ClientCapabilityCatalog api={api} />
      </section>
      <section className="settings-card capability-card" aria-label={tr('项目文件与终端能力')}>
        <div className="settings-card-title">
          <Terminal />
          <div>
            <h3>{tr('项目文件与终端')}</h3>
            <p>
              {tr('项目会话可读取代码、修改文件和运行命令；普通会话也可在自己的工作目录使用终端。')}
            </p>
          </div>
        </div>
        <p className="capability-note">
          {tr('内置能力，无需开启。可在会话中设置只读、按需审批或完全开放权限。')}
        </p>
      </section>
    </div>
  );
}
