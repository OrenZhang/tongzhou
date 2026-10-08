import { useEffect, useState } from 'react';
import { Check, Grip, ShieldCheck, FolderOpen, ExternalLink, RefreshCw } from 'lucide-react';
import { Spinner } from '../../components/components';
import { errorMessage } from '../../lib/feedback';
import type { ComputerPermissionGuide, ComputerStatus, TongzhouAPI } from '../../shared/types';

export function MacComputerPermissions({
  api,
  status,
  onStatus,
}: {
  api: TongzhouAPI;
  status: ComputerStatus;
  onStatus: (next: ComputerStatus) => void;
}) {
  const [guide, setGuide] = useState<ComputerPermissionGuide | null>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    void api.computerPermissionGuide().then(
      (next) => {
        if (live) {
          setGuide(next);
          setMessage('');
          setError(false);
        }
      },
      (reason) => {
        if (live) {
          setGuide(null);
          setError(true);
          setMessage(errorMessage(reason));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [api, retry]);
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
  const missing = !status.accessibility || status.screen !== 'granted';
  return (
    <section className="computer-permission-guide" aria-label="macOS 授权引导">
      <div className="computer-permission-heading">
        <ShieldCheck size={18} />
        <div>
          <strong>macOS 系统权限</strong>
          <p>
            {missing
              ? '截图和输入需要下面两项系统权限。'
              : '两项权限已授权，可以运行电脑控制检测。'}
          </p>
        </div>
      </div>
      <div className="computer-permission-rows">
        {(
          [
            ['accessibility', '辅助功能', status.accessibility, '允许点击、输入文字和使用快捷键。'],
            ['screen', '屏幕录制', status.screen === 'granted', '允许查看需要操作的窗口。'],
          ] as const
        ).map(([permission, name, granted, detail]) => (
          <div className="computer-permission-row" key={permission}>
            <div>
              <strong>{name}</strong>
              <span className={granted ? 'permission-granted' : 'permission-missing'}>
                {granted && <Check size={12} />}
                {granted ? '已授权' : '待授权'}
              </span>
              <p>{detail}</p>
            </div>
            <button
              className="secondary"
              disabled={pending}
              onClick={() =>
                void act(
                  () => api.computerOpenPermissionSettings(permission),
                  `已打开${name}设置。将应用添加到列表并打开开关，完成后返回同舟。`,
                )
              }
            >
              打开{name}设置
              <ExternalLink size={13} />
            </button>
          </div>
        ))}
      </div>
      {guide ? (
        <>
          <p className="computer-permission-instruction">
            打开对应的系统设置后，将下方应用图标拖入应用列表，再打开开关。
          </p>
          <div className="computer-permission-application-row">
            <button
              className="computer-permission-application"
              draggable={!pending}
              disabled={pending}
              aria-label={`拖动 ${guide.name} 到系统设置`}
              title="拖动到系统设置的应用列表；也可点击在 Finder 中显示"
              onDragStart={(event) => {
                event.preventDefault();
                void api.computerDragApplication().catch((reason) => {
                  setError(true);
                  setMessage(errorMessage(reason));
                });
              }}
              onClick={() =>
                void act(
                  () => api.computerRevealApplication(),
                  '已在 Finder 中选中需要授权的应用。',
                )
              }
            >
              <img src={guide.icon} alt="" draggable={false} />
              <span>
                <strong>{guide.name}</strong>
                <small>拖动此图标添加应用</small>
              </span>
              <Grip size={18} />
            </button>
            <button
              className="text-button"
              disabled={pending}
              onClick={() =>
                void act(
                  () => api.computerRevealApplication(),
                  '已在 Finder 中选中需要授权的应用。',
                )
              }
            >
              <FolderOpen size={14} />在 Finder 中显示
            </button>
          </div>
          <p className="computer-permission-path" title={guide.path}>
            {guide.path}
          </p>
          {guide.development && (
            <p className="capability-note">
              当前为开发版，请授权 {guide.name}；安装正式版后需要授权同舟应用。
            </p>
          )}
        </>
      ) : guide === undefined ? (
        <p className="capability-note">
          <Spinner />
          正在加载应用图标…
        </p>
      ) : (
        <button
          className="text-button"
          onClick={() => {
            setGuide(undefined);
            setRetry((old) => old + 1);
          }}
        >
          重试加载应用图标
        </button>
      )}
      <div className="capability-actions">
        <button
          className="text-button"
          disabled={pending}
          onClick={() =>
            void act(async () => {
              onStatus(await api.computerStatus());
            }, '已刷新系统权限状态。')
          }
        >
          <RefreshCw size={14} />
          我已授权，重新检查
        </button>
      </div>
      <p className="capability-note">
        若列表中没有应用，可点“＋”并选择上方路径。屏幕录制授权后，按系统提示退出并重新打开同舟。
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
