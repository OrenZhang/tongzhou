import { t as tr } from '../../shared/i18n';
import { useState } from 'react';
import type { Provider, TongzhouAPI } from '../../shared/types';
import type { ConnectionCheck } from '../../shared/connection-diagnostics';
export function ConnectionDiagnostics({
  api,
  onSave,
  models,
}: {
  api: TongzhouAPI;
  onSave: () => Promise<Provider>;
  models: string[];
}) {
  const [busy, setBusy] = useState(false),
    [inference, setInference] = useState(false),
    [checks, setChecks] = useState<ConnectionCheck[]>([]),
    [error, setError] = useState(''),
    [model, setModel] = useState('');
  const selected = models.includes(model) ? model : models[0] || '';
  return (
    <section className="task-block">
      <h3>{tr('分项连接检测')}</h3>
      <p className="muted">{tr('分别检查网络、账号与模型。授权通过不会被标记为推理通过。')}</p>
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={inference}
          onChange={(e) => setInference(e.target.checked)}
        />
        {tr('直接 API 同时做一次真实推理和无副作用工具测试（可能计费）')}
      </label>
      {inference && (
        <label>
          {tr('检测模型')}
          <select
            aria-label={tr('检测模型')}
            value={selected}
            disabled={busy}
            onChange={(e) => {
              setModel(e.target.value);
              setChecks([]);
            }}
          >
            {models.filter(Boolean).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          setChecks([]);
          void onSave()
            .then((p) => api.diagnoseProvider(p.id, selected, inference))
            .then(setChecks)
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? tr('正在检测…') : checks.length ? tr('重新检测') : tr('保存并分项检测')}
      </button>
      {checks.map((c, i) => (
        <div className="settings-row" key={i}>
          <span>
            {c.name} · {{ passed: tr('通过'), failed: tr('失败'), unknown: tr('待验证') }[c.status]}
          </span>
          <span>
            {c.detail} {c.ms > 0 ? `(${c.ms} ms)` : ''}
          </span>
        </div>
      ))}
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
    </section>
  );
}
