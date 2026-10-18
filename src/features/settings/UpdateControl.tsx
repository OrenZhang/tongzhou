import { t as tr } from '../../shared/i18n';
import { useEffect, useState } from 'react';
import { CircleArrowDown, LoaderCircle, RefreshCw } from 'lucide-react';
import type { UpdateState } from '../../shared/updates';
import type { TongzhouAPI } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';

export function UpdateControl({ api, settings = false }: { api: TongzhouAPI; settings?: boolean }) {
  const [state, setState] = useState<UpdateState>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api
      .updateStatus()
      .then((s) => {
        if (live) setState(s);
      })
      .catch(() => {});
    const off = api.onEvent((e) => {
      if (e.type === 'update') setState(e.state);
    });
    return () => {
      live = false;
      off();
    };
  }, [api]);
  if (!state) return null;
  const working = ['checking', 'downloading', 'installing'].includes(state.phase);
  const available = !!state.version;
  const label =
    state.phase === 'downloading'
      ? tr('正在下载 {0}%', [state.progress ?? 0])
      : state.phase === 'installing'
        ? tr('正在安装')
        : state.phase === 'downloaded'
          ? tr('安装并重启')
          : state.automaticInstall
            ? tr('更新到 {0}', [state.version])
            : tr('下载新版 {0}', [state.version]);
  const install = async () => {
    setError('');
    try {
      await api.installUpdate();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (!settings)
    return available ? (
      <div className="sidebar-update">
        <button
          className="icon-button"
          aria-label={label}
          title={error || (state.message ? tr(state.message) : undefined) || label}
          disabled={working}
          aria-busy={working}
          onClick={() => void install()}
        >
          {working ? <LoaderCircle size={20} className="spin" /> : <CircleArrowDown size={20} />}
        </button>
        {error && (
          <div className="update-error" role="alert">
            {error}
          </div>
        )}
      </div>
    ) : null;
  return (
    <section className="settings-card update-settings">
      <div>
        <h3>{tr('版本更新')}</h3>
        <p>
          {tr('当前版本 ')}
          {state.currentVersion}
          {tr(' · 安装包由 GitHub Releases 提供')}
        </p>
      </div>
      <p role="status">
        {error ||
          (state.message ? tr(state.message) : undefined) ||
          (working ? tr('正在检查更新…') : tr('检查可用的新版本'))}
      </p>
      <div className="row">
        <button
          className="secondary"
          disabled={working || state.phase === 'unsupported'}
          onClick={() => {
            setError('');
            void api.checkUpdates().catch((e) => setError(errorMessage(e)));
          }}
        >
          <RefreshCw size={14} />
          {tr('检查更新')}
        </button>
        {available && (
          <button className="primary" disabled={working} onClick={() => void install()}>
            {label}
          </button>
        )}
        <button
          className="text-button"
          onClick={() => {
            setError('');
            void api
              .openExternalLink('https://github.com/OrenZhang/tongzhou/releases')
              .catch((e) => setError(errorMessage(e)));
          }}
        >
          {tr('打开发布页面')}
        </button>
      </div>
    </section>
  );
}
