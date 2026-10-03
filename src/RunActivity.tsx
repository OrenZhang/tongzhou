import { useEffect, useState } from 'react';
import type { Run, RunEvent, Snapshot, TongzhouAPI } from './shared/types';

export function RunActivity({
  api,
  sessionId,
  run,
  data,
}: {
  api: TongzhouAPI;
  sessionId: string;
  run?: Run;
  data: Snapshot;
}) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  useEffect(() => {
    let alive = true;
    setEvents([]);
    if (!sessionId) return;
    void api
      .runEvents(sessionId)
      .then((e) => {
        if (alive)
          setEvents((old) => {
            const merged = new Map(e.map((v) => [v.id, v]));
            for (const v of old) merged.set(v.id, v);
            return [...merged.values()];
          });
      })
      .catch((e) => alive && setError(String(e)));
    const off = api.onEvent((e) => {
      if (e.type === 'run-event' && e.event.sessionId === sessionId)
        setEvents((old) => [...old.filter((v) => v.id !== e.event.id), e.event]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api, sessionId]);
  useEffect(() => {
    if (!run) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [run?.id]);
  const latestRunId = run?.id ?? events.at(-1)?.runId;
  const relevant = events.filter((e) => e.runId === latestRunId).sort((a, b) => a.seq - b.seq);
  const phase = relevant.filter((e) => e.type === 'phase').at(-1)?.text ?? '准备请求';
  return (
    <div className="run-activity" aria-live="polite">
      {run && (
        <p>
          <span className="live-dot" /> {phase} ·{' '}
          {Math.max(0, Math.floor((now - run.startedAt) / 1000))} 秒
        </p>
      )}
      {relevant.length > 0 && (
        <details>
          <summary>处理过程</summary>
          {relevant.map((e) => (
            <div key={e.id} className="run-event">
              <small>{new Date(e.time).toLocaleTimeString()}</small>
              <pre>{e.text}</pre>
            </div>
          ))}
        </details>
      )}
      {(data.pendingInputs ?? [])
        .filter((p) => p.sessionId === sessionId)
        .map((p) => (
          <div className="queued-input" key={p.id}>
            <span>
              {p.status === 'dispatching'
                ? '已送交引擎，等待确认'
                : p.status === 'paused'
                  ? '待恢复'
                  : p.mode === 'supplement'
                    ? '等待补充到下一安全点'
                    : '等待下一轮'}
              ：{p.input.prompt}
            </span>
            {p.status === 'paused' && (
              <button onClick={() => void api.resumeInput(p.id).catch((e) => setError(String(e)))}>
                继续
              </button>
            )}
            {editing === p.id && (
              <>
                <textarea
                  aria-label="编辑排队消息"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button
                  onClick={() =>
                    void api
                      .editInput(p.id, draft)
                      .then(() => setEditing(''))
                      .catch((e) => setError(String(e)))
                  }
                >
                  保存
                </button>
                <button onClick={() => setEditing('')}>放弃修改</button>
              </>
            )}
            {p.status !== 'dispatching' && (
              <button
                onClick={() => {
                  setEditing(p.id);
                  setDraft(p.input.prompt);
                }}
              >
                编辑
              </button>
            )}
            <button
              disabled={p.status === 'dispatching'}
              onClick={() => void api.cancelInput(p.id).catch((e) => setError(String(e)))}
            >
              取消
            </button>
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
