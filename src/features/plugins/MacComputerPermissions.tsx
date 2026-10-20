import { t as tr } from '../../shared/i18n';
import { useState } from 'react';
import { Check, ShieldCheck, FolderOpen, ExternalLink, RefreshCw } from 'lucide-react';
import { errorMessage } from '../../lib/feedback';
import type { ComputerStatus, TongzhouAPI } from '../../shared/types';

export function MacComputerPermissions({
  api,
  status,
  onStatus,
}: {
  api: TongzhouAPI;
  status: ComputerStatus;
  onStatus: (next: ComputerStatus) => void;
}) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const act = async (fn: () => Promise<void>, success: string) => {
    setPending(true);
    setMessage('');
    setError(false);
    try {
      await fn();
      setMessage(success);
    } catch (reason) {
      setError(true);
      setMessage(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  const assistant = status.permissionAssistant !== false;
  const missing = !status.accessibility || status.screen !== 'granted';
  return (
    <section className="computer-permission-guide" aria-label={tr('macOS 授权引导')}>
      <div className="computer-permission-heading">
        <ShieldCheck size={18} />
        <div>
          <strong>{tr('macOS 系统权限')}</strong>
          <p>
            {missing
              ? tr('截图和输入需要下面两项系统权限。')
              : tr('两项权限已授权，可以运行电脑控制检测。')}
          </p>
        </div>
      </div>
      <div className="computer-permission-rows">
        {(
          [
            [
              'accessibility',
              tr('辅助功能'),
              status.accessibility,
              tr('允许点击、输入文字和使用快捷键。'),
            ],
            ['screen', tr('屏幕录制'), status.screen === 'granted', tr('允许查看需要操作的窗口。')],
          ] as const
        ).map(([permission, name, granted, detail]) => (
          <div className="computer-permission-row" key={permission}>
            <div>
              <strong>{name}</strong>
              <span className={granted ? 'permission-granted' : 'permission-missing'}>
                {granted && <Check size={12} />}
                {granted ? tr('已授权') : tr('待授权')}
              </span>
              <p>{detail}</p>
            </div>
            <button
              className="secondary"
              disabled={pending}
              onClick={() =>
                void act(
                  () => api.computerOpenPermissionSettings(permission),
                  assistant
                    ? tr('已打开{0}设置。请将授权浮窗中的应用图标拖入列表，完成后返回CoSail。', [
                        name,
                      ])
                    : tr(
                        '已打开{0}设置。可点击“在 Finder 中显示”，将当前应用拖入列表后打开开关。',
                        [name],
                      ),
                )
              }
            >
              {tr('打开')}
              {name}
              {tr('设置')}
              <ExternalLink size={13} />
            </button>
          </div>
        ))}
      </div>
      <p className="computer-permission-instruction">
        {assistant
          ? tr(
              '打开系统设置后，授权浮窗会显示在设置窗口下方或旁边。将浮窗中的CoSail图标拖入应用列表，再打开开关。',
            )
          : tr('点击“在 Finder 中显示”，将当前预览应用拖入系统设置的应用列表，再打开所需权限。')}
      </p>
      <div className="capability-actions">
        <button
          className="text-button"
          disabled={pending}
          onClick={() =>
            void act(async () => {
              onStatus(await api.computerStatus());
            }, tr('已刷新系统权限状态。'))
          }
        >
          <RefreshCw size={14} />
          {tr('我已授权，重新检查')}
        </button>
        <button
          className="text-button"
          disabled={pending}
          onClick={() =>
            void act(
              () => api.computerRevealApplication(),
              tr('已在 Finder 中选中需要授权的应用。'),
            )
          }
        >
          <FolderOpen size={14} />
          {tr('在 Finder 中显示')}
        </button>
      </div>
      <p className="capability-note">
        {tr(
          '也可从 Finder 将应用拖入列表，或点“＋”添加。屏幕录制授权后，按系统提示退出并重新打开CoSail。',
        )}
      </p>
      {message && (
        <p
          className={'capability-feedback ' + (error ? 'is-error' : '')}
          role={error ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}
    </section>
  );
}
