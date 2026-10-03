import { useEffect, useState } from 'react';
import type { Message, Run, RunEvent, Snapshot, TongzhouAPI } from './shared/types';
import { ChatMessage } from './components';

export function useRunEvents(api: TongzhouAPI, sessionId: string) {
  const [state, setState] = useState({ sessionId: '', events: [] as RunEvent[], error: '' });
  useEffect(() => {
    let alive = true;
    setState({ sessionId, events: [], error: '' });
    if (!api || !sessionId) return;
    // Subscribe before loading history so streaming updates cannot fall into a gap.
    const off = api.onEvent((e) => {
      if (alive && e.type === 'run-event' && e.event.sessionId === sessionId)
        setState((old) => ({
          sessionId,
          error: '',
          events: [...old.events.filter((v) => v.id !== e.event.id), e.event],
        }));
    });
    void api
      .runEvents(sessionId)
      .then((events) => {
        if (!alive) return;
        setState((old) => {
          const merged = new Map(events.map((event) => [event.id, event]));
          for (const event of old.events) merged.set(event.id, event);
          return { sessionId, events: [...merged.values()], error: '' };
        });
      })
      .catch((e) => alive && setState((old) => ({ ...old, error: String(e) })));
    return () => {
      alive = false;
      off();
    };
  }, [api, sessionId]);
  return state.sessionId === sessionId ? state : { sessionId, events: [], error: '' };
}

export function RunActivity({
  events,
  run,
  tools = [],
}: {
  events: RunEvent[];
  run?: Run;
  tools?: Message[];
}) {
  const [now, setNow] = useState(Date.now());
  const active = run?.status === 'running';
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, run?.id]);
  const phase = events.filter((e) => e.type === 'phase').at(-1)?.text ?? '准备请求';
  if (!events.length && !tools.length && !active) return null;
  return (
    <div className="run-activity">
      {active && run && (
        <p className="run-phase" role="status">
          <span className="live-dot" /> {phase} ·{' '}
          {Math.max(0, Math.floor((now - run.startedAt) / 1000))} 秒
        </p>
      )}
      {(events.length > 0 || tools.length > 0) && (
        <details>
          <summary>处理过程</summary>
          <div className="run-event-list">
            {events.map((e) => (
              <div key={e.id} className="run-event">
                <small>{new Date(e.time).toLocaleTimeString()}</small>
                <pre>{e.text}</pre>
              </div>
            ))}
            {tools.map((m) => (
              <ChatMessage key={m.id} message={m} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function PendingInputs({
  api,
  sessionId,
  data,
}: {
  api: TongzhouAPI;
  sessionId: string;
  data: Snapshot;
}) {
  const [error, setError] = useState('');
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  return (
    <div className="pending-inputs">
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
