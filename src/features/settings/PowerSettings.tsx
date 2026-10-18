import { t as tr } from '../../shared/i18n';
import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';
import type { PowerPreferences, PowerState } from '../../shared/power';
import type { TongzhouAPI } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';

export function PowerSettings({ api }: { api: TongzhouAPI }) {
  const [state, setState] = useState<PowerState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api
      .powerStatus()
      .then((value) => {
        if (live) setState(value);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    const off = api.onEvent((event) => {
      if (event.type === 'power') setState(event.state);
    });
    return () => {
      live = false;
      off();
    };
  }, [api]);
  async function save(value: PowerPreferences) {
    setBusy(true);
    setError('');
    setState((current) => current && { ...current, ...value });
    try {
      setState(await api.savePowerSettings(value));
    } catch (e) {
      setError(errorMessage(e));
      await api
        .powerStatus()
        .then(setState)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card power-settings" aria-label={tr('电源与睡眠')}>
      <div className="settings-card-title">
        <PlugZap size={22} />
        <div>
          <h3>{tr('电源与睡眠')}</h3>
          <p>{tr('接通电源时让CoSail继续运行，屏幕仍可正常熄灭。')}</p>
        </div>
      </div>
      {state && (
        <>
          <p role="status">
            {!state.supported
              ? tr('此功能目前支持 Windows 和 macOS。')
              : state.onBatteryPower
                ? tr('当前使用电池 · 保持唤醒已暂停，遵循系统睡眠设置')
                : state.active
                  ? tr('已接通电源 · 正在保持唤醒')
                  : tr('已接通电源 · 遵循系统睡眠设置')}
          </p>
          <label className="task-confirm">
            <input
              type="checkbox"
              checked={state.keepAwakeOnAC}
              disabled={busy || !state.supported || (state.onBatteryPower && !state.keepAwakeOnAC)}
              onChange={(event) =>
                void save({
                  keepAwakeOnAC: event.target.checked,
                  keepAwakeWhenLidClosed: state.keepAwakeWhenLidClosed,
                })
              }
            />
            {tr('接通电源时保持唤醒')}
          </label>
          <p>
            {tr('防止空闲自动睡眠。最小化或隐藏到托盘后继续生效；拔掉电源或退出CoSail后恢复。')}
          </p>
          <label className="task-confirm">
            <input
              type="checkbox"
              checked={state.keepAwakeWhenLidClosed}
              disabled={
                busy ||
                !state.supported ||
                (!state.keepAwakeWhenLidClosed && (!state.keepAwakeOnAC || state.onBatteryPower))
              }
              onChange={(event) =>
                void save({
                  keepAwakeOnAC: state.keepAwakeOnAC,
                  keepAwakeWhenLidClosed: event.target.checked,
                })
              }
            />
            {tr('接通电源时合盖不睡眠')}
          </label>
          <p>
            {state.platform === 'darwin'
              ? tr(
                  '无需外接显示器。启用时需管理员授权，会临时禁用系统睡眠（包括手动睡眠）；拔电、关闭功能或退出后恢复。每次启动CoSail后需重新开启合盖模式。',
                )
              : tr(
                  '临时修改接通电源时的合盖动作，电池合盖策略保持不变；关闭功能或退出CoSail后恢复原设置。',
                )}
          </p>
          {state.keepAwakeWhenLidClosed && (
            <p role="status">
              {state.lidActive && state.active
                ? tr('合盖保持唤醒已生效')
                : tr('合盖保持唤醒尚未生效')}
            </p>
          )}
          <p>{tr('合盖运行时请保持散热通畅，勿将运行中的电脑放入包内。')}</p>
          {busy && (
            <p role="status">
              {tr('正在应用电源设置')}
              {state.platform === 'darwin' ? tr('，如弹出系统授权窗口请完成授权') : ''}…
            </p>
          )}
          {(error || state.error) && (
            <div role="alert" className="task-error">
              <p>{error || state.error}</p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void save({
                    keepAwakeOnAC: state.keepAwakeOnAC,
                    keepAwakeWhenLidClosed: state.keepAwakeWhenLidClosed,
                  })
                }
              >
                {tr('重试电源设置')}
              </button>
            </div>
          )}
        </>
      )}
      {!state && <p role={error ? 'alert' : 'status'}>{error || tr('正在读取电源状态…')}</p>}
    </section>
  );
}
