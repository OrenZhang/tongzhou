import { useState } from 'react';
import type { Provider, TongzhouAPI } from './shared/types';
export interface ConnectionCheck {
  name: string;
  status: 'passed' | 'failed' | 'unknown';
  detail: string;
  ms: number;
}
export function ConnectionDiagnostics({
  api,
  onSave,
}: {
  api: TongzhouAPI;
  onSave: () => Promise<Provider>;
}) {
  const [busy, setBusy] = useState(false),
    [inference, setInference] = useState(false),
    [checks, setChecks] = useState<ConnectionCheck[]>([]),
    [error, setError] = useState('');
  return (
    <section className="task-block">
      <h3>分项连接检测</h3>
      <p className="muted">分别检查网络、账号与模型。授权通过不会被标记为推理通过。</p>
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={inference}
          onChange={(e) => setInference(e.target.checked)}
        />
        直接 API 同时做一次真实推理和无副作用工具测试（可能计费）
      </label>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          setChecks([]);
          void onSave()
            .then((p) => api.diagnoseProvider(p.id, p.models[0] || '', inference))
            .then(setChecks)
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? '正在检测…' : checks.length ? '重新检测' : '保存并分项检测'}
      </button>
      {checks.map((c, i) => (
        <div className="settings-row" key={i}>
          <span>
            {c.name} · {{ passed: '通过', failed: '失败', unknown: '待验证' }[c.status]}
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
