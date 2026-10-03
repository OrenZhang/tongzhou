import { useEffect, useId, useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import type { Run, RunEvent, Snapshot, TongzhouAPI } from './shared/types';
import { Markdown, Spinner } from './components';

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

export function TurnThinking({
  events,
  run,
  active,
}: {
  events: RunEvent[];
  run?: Run;
  active: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const [manual, setManual] = useState<{ phase: string; open: boolean }>();
  const contentId = useId();
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, run?.id]);
  const phase = events.filter((e) => e.type === 'phase').at(-1)?.text ?? '准备上下文';
  const summaries = events.filter((e) => e.type === 'reasoning' && e.text.trim());
  const phaseKey = active ? phase : 'finished';
  const expanded = manual?.phase === phaseKey ? manual.open : active && phase === '思考中';
  const labels: Record<string, string> = {
    准备上下文: '准备中',
    准备工具: '准备中',
    连接模型: '正在连接',
    等待模型响应: '等待回复',
    调用工具: '正在处理',
  };
  const label = active ? (labels[phase] ?? phase) : '思考摘要';
  if (!summaries.length && !active) return null;
  const heading = (
    <>
      {active ? <Spinner /> : <Brain size={14} />}
      <span role={active ? 'status' : undefined}>{label}</span>
      {active && run && (
        <small>已用 {Math.max(0, Math.floor((now - run.startedAt) / 1000))} 秒</small>
      )}
    </>
  );
  return (
    <div className="turn-thinking">
      {summaries.length ? (
        <>
          <button
            className="thinking-toggle"
            aria-label="思考摘要"
            title={expanded ? '收起思考摘要' : '展开思考摘要'}
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setManual({ phase: phaseKey, open: !expanded })}
          >
            {heading}
            <ChevronDown size={13} className={expanded ? 'rotate' : ''} />
          </button>
          <div id={contentId} className="thinking-summary" hidden={!expanded}>
            {summaries.map((event) => (
              <Markdown key={event.id} text={event.text} />
            ))}
          </div>
        </>
      ) : (
        <div className="thinking-state">{heading}</div>
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
