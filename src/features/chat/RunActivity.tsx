import { t as tr, localize as localized } from '../../shared/i18n';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Circle } from 'lucide-react';
import type { Run, RunEvent, Snapshot, TongzhouAPI } from '../../shared/types';
import { formatDuration } from '../../shared/turns';
import { Spinner } from '../../components/components';
import { agentPlan, parseAgentPlan } from '../../shared/agent-plan';
import { AgentActivity } from './AgentActivity';
import type { ChildAgent, ExecutionObservation } from '../../shared/agent-execution';
import {
  modelScenes as raw_modelScenes,
  modelStages as raw_modelStages,
} from '../../shared/model-protocol';

export function useRunEvents(api: TongzhouAPI, sessionId: string) {
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [state, setState] = useState({ sessionId: '', events: [] as RunEvent[], error: '' });
  useEffect(() => {
    let alive = true;
    setState({ sessionId, events: [], error: '' });
    setHasEarlier(false);
    if (!api || !sessionId) return;
    // Subscribe before loading history so streaming updates cannot fall into a gap.
    const off = api.onEvent((e) => {
      if (alive && e.type === 'run-event' && e.event.sessionId === sessionId)
        setState((old) => ({
          sessionId,
          error: '',
          events: old.events.some((v) => v.id === e.event.id)
            ? old.events.map((v) => (v.id === e.event.id ? e.event : v))
            : [...old.events, e.event],
        }));
    });
    void api
      .runEvents(sessionId)
      .then((events) => {
        if (!alive) return;
        setHasEarlier(events.length === 300);
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
  const loadEarlier = async () => {
    if (loadingEarlier || !state.events.length) return;
    setLoadingEarlier(true);
    try {
      const events = await api.runEvents(sessionId, state.events[0].id);
      setHasEarlier(events.length === 300);
      setState((old) =>
        old.sessionId !== sessionId
          ? old
          : {
              ...old,
              events: [...events, ...old.events.filter((e) => !events.some((x) => x.id === e.id))],
            },
      );
    } catch (e) {
      setState((old) => ({ ...old, error: String(e) }));
    } finally {
      setLoadingEarlier(false);
    }
  };
  return {
    ...(state.sessionId === sessionId ? state : { sessionId, events: [], error: '' }),
    hasEarlier,
    loadingEarlier,
    loadEarlier,
  };
}

export function TurnProcess({
  events,
  run,
  active,
  hasContent,
  children,
  collapsedContent,
  onAgentControl,
}: {
  events: RunEvent[];
  run?: Run;
  active: boolean;
  hasContent: boolean;
  children: ReactNode;
  collapsedContent?: ReactNode;
  onAgentControl?: (id: string, action: 'interrupt' | 'resume') => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  const [manual, setManual] = useState<{ phase: string; open: boolean }>();
  const contentId = useId();
  const eventPlan = events
    .filter((e) => e.type === 'plan')
    .map((e) => parseAgentPlan(e.text))
    .findLast(Boolean);
  const savedPlan = agentPlan(run?.plan);
  const plan = active ? (eventPlan ?? savedPlan) : (savedPlan ?? eventPlan);
  const snapshot = <T,>(type: RunEvent['type']): T | undefined => {
    try {
      return JSON.parse(events.filter((e) => e.type === type).at(-1)?.text ?? 'null') ?? undefined;
    } catch {
      return;
    }
  };
  const agents =
    (active
      ? (snapshot<ChildAgent[]>('agents') ?? run?.agents)
      : (run?.agents ?? snapshot<ChildAgent[]>('agents'))) ?? [];
  const observation = active
    ? (snapshot<ExecutionObservation>('observation') ?? run?.observation)
    : (run?.observation ?? snapshot<ExecutionObservation>('observation'));
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, run?.id]);
  const phase =
    events.filter((e) => e.type === 'phase').at(-1)?.text ?? run?.phase ?? tr('准备上下文');
  const phaseKey = active ? 'active' : 'finished';
  const explicitlyExpanded = manual?.phase === phaseKey && manual.open;
  const expanded =
    manual?.phase === phaseKey
      ? manual.open
      : active && (hasContent || !!plan || agents.length > 0);
  const labels: Record<string, string> = {
    准备上下文: tr('准备中'),
    准备工具: tr('准备中'),
    连接模型: tr('正在连接'),
    等待模型响应: tr('等待回复'),
    调用工具: tr('正在执行工具'),
  };
  const label = labels[phase] ?? phase;
  const elapsed = run
    ? formatDuration((active ? now : (run.endedAt ?? run.startedAt)) - run.startedAt)
    : undefined;
  const ordered = events.filter((e) => e.type === 'phase').sort((a, b) => a.time - b.time);
  const waiting = ordered.find((e) => e.text === '等待模型响应');
  const output = ordered.find(
    (e) =>
      (!waiting || e.time >= waiting.time) &&
      [tr('正在回复'), tr('正在说明进度'), tr('思考中'), tr('调用工具')].includes(e.text),
  );
  const timing =
    run && waiting
      ? tr('准备 {0} · {1}', [
          formatDuration(waiting.time - run.startedAt),
          output
            ? '首条输出 ' + formatDuration(output.time - waiting.time)
            : '等待首条输出 ' + formatDuration((active ? now : run.endedAt || now) - waiting.time),
        ])
      : '';
  if (!run && !events.length) return <>{children}</>;
  return (
    <>
      <div className="turn-process">
        <button
          className="process-toggle"
          aria-label={tr('本轮用时与处理过程')}
          title={expanded ? tr('收起本轮处理过程') : tr('展开本轮处理过程')}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setManual({ phase: phaseKey, open: !expanded })}
        >
          {active && !expanded && <Spinner />}
          <span>{elapsed === undefined ? tr('本轮过程') : tr('用时 {0}', [elapsed])}</span>
          {active && !expanded && <small>{label}</small>}
          <ChevronDown size={13} className={expanded ? 'rotate' : ''} />
        </button>
        <div id={contentId} className="process-timeline" hidden={!expanded}>
          {run?.routing && (
            <small className="execution-meta muted">
              {tr('自动路由：')}
              {modelScenes[run.routing.scene]} · {modelStages[run.routing.stage]} · {run.model}
              {run.config?.reasoningEffort ? tr(' · 思考 {0}', [run.config.reasoningEffort]) : ''}
              {run.routing.fallback ? tr(' · 首选不可用，使用后备') : ''}
            </small>
          )}
          {observation && (
            <small className="execution-meta muted">
              {tr('执行模型：')}
              {observation.actualModel}
              {run?.config?.reasoningEffort ? tr(' · 思考 {0}', [run.config.reasoningEffort]) : ''}
              {observation.compactions > 0
                ? tr(' · 上下文整理 {0} 次', [observation.compactions])
                : ''}
              {run?.usageReported
                ? ` · ${observation.usageIncomplete ? tr('已上报 ') : ''}Tokens ${run.inputTokens + run.outputTokens}${observation.usageIncomplete ? tr('（部分未上报）') : ''}`
                : tr(' · 用量未上报')}
            </small>
          )}
          {observation && observation.reroutes.length > 0 && (
            <small className="muted">
              {tr('模型调整：')}
              {observation.reroutes.map((r) => `${r.fromModel} → ${r.toModel}`).join('；')}
            </small>
          )}
          <AgentActivity agents={agents} active={active} onControl={onAgentControl} />
          {!!run?.completionChecks?.checks.length && (
            <section className="agent-plan" aria-label={tr('完成检查')}>
              <small className="muted">
                {tr('完成检查 · ')}
                {run.completionChecks.checks.filter((c) => c.status === 'passed').length}/
                {run.completionChecks.checks.length}
                {tr(' · 第 ')}
                {run.completionChecks.attempts}
                {tr(' 轮')}
              </small>
              <ol>
                {run.completionChecks.checks.map((c) => (
                  <li key={c.command} title={c.command}>
                    {c.status === 'passed' ? <Check size={13} /> : <Circle size={11} />}
                    <span>
                      {c.description} ·{' '}
                      {
                        {
                          pending: tr('待检查'),
                          passed: tr('通过'),
                          failed: tr('未通过'),
                          blocked: tr('未执行成功'),
                        }[c.status]
                      }
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {timing && explicitlyExpanded && (
            <small className="muted">
              {timing}
              {tr('（包含网络与服务端等待）')}
            </small>
          )}
          {plan && plan.plan.length > 0 && (
            <section className="agent-plan" aria-label={tr('任务计划')}>
              <small className="muted">
                {tr('任务计划 · ')}
                {plan.plan.filter((s) => s.status === 'completed').length}/{plan.plan.length}
              </small>
              <ol>
                {plan.plan.map((step, index) => (
                  <li key={index} data-status={step.status}>
                    {step.status === 'completed' ? (
                      <Check size={13} aria-label={tr('已完成')} />
                    ) : step.status === 'inProgress' && active ? (
                      <Spinner />
                    ) : (
                      <Circle
                        size={11}
                        aria-label={step.status === 'inProgress' ? tr('未完成') : tr('待处理')}
                      />
                    )}
                    <span>{step.step}</span>
                  </li>
                ))}
              </ol>
              {plan.explanation && <small className="muted">{plan.explanation}</small>}
            </section>
          )}
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
                ? tr('已送交引擎，等待确认')
                : p.status === 'paused'
                  ? tr('待恢复')
                  : p.mode === 'supplement'
                    ? tr('等待补充到下一安全点')
                    : tr('等待下一轮')}
              ：{p.input.prompt}
              {p.input.attachmentIds?.length
                ? tr(' · {0} 个附件', [p.input.attachmentIds.length])
                : ''}
            </span>
            {p.status === 'paused' && (
              <button onClick={() => void api.resumeInput(p.id).catch((e) => setError(String(e)))}>
                {tr('继续')}
              </button>
            )}
            {editing === p.id && (
              <>
                <textarea
                  aria-label={tr('编辑排队消息')}
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
                  {tr('保存')}
                </button>
                <button onClick={() => setEditing('')}>{tr('放弃修改')}</button>
              </>
            )}
            {p.status !== 'dispatching' && (
              <button
                onClick={() => {
                  setEditing(p.id);
                  setDraft(p.input.prompt);
                }}
              >
                {tr('编辑')}
              </button>
            )}
            <button
              disabled={p.status === 'dispatching'}
              onClick={() => void api.cancelInput(p.id).catch((e) => setError(String(e)))}
            >
              {tr('取消')}
            </button>
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

const modelScenes = localized(raw_modelScenes);
const modelStages = localized(raw_modelStages);
