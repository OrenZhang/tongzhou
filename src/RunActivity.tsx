import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Run, RunEvent, Snapshot, TongzhouAPI } from './shared/types';
import { formatDuration } from './shared/turns';
import { Spinner } from './components';

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

export function TurnProcess({
  events,
  run,
  active,
  children,
  collapsedContent,
}: {
  events: RunEvent[];
  run?: Run;
  active: boolean;
  children: ReactNode;
  collapsedContent?: ReactNode;
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
  const phase = events.filter((e) => e.type === 'phase').at(-1)?.text ?? run?.phase ?? '准备上下文';
  const phaseKey = active ? 'active' : 'finished';
  const expanded = manual?.phase === phaseKey ? manual.open : active;
  const labels: Record<string, string> = {
    准备上下文: '准备中',
    准备工具: '准备中',
    连接模型: '正在连接',
    等待模型响应: '等待回复',
    调用工具: '正在执行工具',
  };
  const label = labels[phase] ?? phase;
  const elapsed = run
    ? formatDuration((active ? now : (run.endedAt ?? run.startedAt)) - run.startedAt)
    : undefined;
  if (!run && !events.length) return <>{children}</>;
  return (
    <>
      <div className="turn-process">
        <button
          className="process-toggle"
          aria-label="本轮用时与处理过程"
          title={expanded ? '收起本轮处理过程' : '展开本轮处理过程'}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setManual({ phase: phaseKey, open: !expanded })}
        >
          {active && !expanded && <Spinner />}
          <span>{elapsed === undefined ? '本轮过程' : `用时 ${elapsed}`}</span>
          {active && !expanded && <small>{label}</small>}
          <ChevronDown size={13} className={expanded ? 'rotate' : ''} />
        </button>
        <div id={contentId} className="process-timeline" hidden={!expanded}>
          {children}
          {active && (
            <div className="process-current" role="status">
              <Spinner />
              {label}
            </div>
          )}
        </div>
      </div>
      {!expanded && collapsedContent}
    </>
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
