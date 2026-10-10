import { useEffect, useState } from 'react';
import type { Snapshot, TongzhouAPI, Session } from '../../shared/types';
import type {
  AutomationJobView,
  AutomationInput,
  AutomationState,
  ContentFlowInput,
  TaskSchedule,
} from '../../shared/automation';
import type { ContentState } from '../../shared/content';
import { Field, Markdown } from '../../components/components';
import { knowledgeFolderPath } from '../../shared/knowledge';
import './automation.css';
import { ModelAgentFields, ScheduleFields, defaultSchedule } from './AutomationFields';

const statuses = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const triggers = {
  manual: '手动',
  import: '导入完成',
  ready: '标记就绪',
  schedule: '定时',
  idle: '空闲时',
};
const date = (v?: number) => (v ? new Date(v).toLocaleString() : '—');
export function AutomationCenter({
  api,
  data,
  onSession,
  onDocument,
  initialTab = 'rules',
}: {
  api: TongzhouAPI;
  data: Snapshot;
  onSession?(s: Session): void;
  onDocument?(id: string, libraryId: string): void;
  initialTab?: 'flows' | 'rules' | 'jobs';
}) {
  const [tab, setTab] = useState(initialTab),
    [state, setState] = useState<AutomationState>({
      capabilities: [],
      flows: [],
      rules: [],
      jobs: [],
    });
  const capability = (kind: string) => state.capabilities.find((c) => c.kind === kind);
  const [flow, setFlow] = useState<ContentFlowInput>(),
    [rule, setRule] = useState<AutomationInput>();
  const [contents, setContents] = useState<ContentState>(),
    [libraries, setLibraries] = useState<ContentState['libraries']>([]);
  const [selected, setSelected] = useState(''),
    [filter, setFilter] = useState('all');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [detail, setDetail] = useState<AutomationJobView>();
  const selectedJob = state.jobs.find((j) => j.id === selected);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    if (selected)
      void api
        .automationJobRead(selected)
        .then((v) => {
          if (active) setDetail(v);
        })
        .catch((e) => setError(String(e)));
    return () => {
      active = false;
    };
  }, [selected, selectedJob?.status, selectedJob?.attempt]);
  const refresh = async () => setState(await api.automationState());
  useEffect(() => {
    let active = true;
    const update = () =>
      void api
        .automationState()
        .then((s) => {
          if (active) setState(s);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    update();
    const timer = setInterval(update, 2000);
    void api
      .contentState('default')
      .then((c) => {
        if (active) setLibraries(c.libraries);
      })
      .catch((e) => setError(String(e)));
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let active = true;
    setContents(undefined);
    if (rule?.kind === 'content')
      void api
        .contentState(rule.libraryId ?? 'default')
        .then((c) => {
          if (active) setContents(c);
        })
        .catch((e) => setError(String(e)));
    return () => {
      active = false;
    };
  }, [rule?.libraryId, rule?.kind]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const connection = () => ({
    providerId: data.providers.find((p) => p.enabled !== false)?.id ?? '',
    model: data.providers.find((p) => p.enabled !== false)?.models[0] ?? '',
    agentId: '',
  });
  const newRule = (kind: 'content' | 'task') => {
    setFlow(undefined);
    setRule({
      name: '',
      kind,
      enabled: true,
      trigger: kind === 'task' ? 'schedule' : 'manual',
      flowId: kind === 'content' ? state.flows[0]?.id : undefined,
      libraryId: kind === 'content' ? 'default' : undefined,
      ...(kind === 'task' ? { ...connection(), prompt: '' } : {}),
      permission: 'read-only',
      missed: 'once',
      schedule: {
        kind: 'daily',
        time: '09:00',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekdays: [1, 2, 3, 4, 5],
      },
    });
  };
  const job = selectedJob
    ? { ...detail, ...selectedJob, result: detail?.id === selected ? detail.result : undefined }
    : undefined;
  const schedule = rule?.schedule;
  const setSchedule = (s: TaskSchedule) => setRule({ ...rule!, schedule: s });
  const scheduleLabel = (s?: TaskSchedule) =>
    !s
      ? ''
      : s.kind === 'interval'
        ? `每 ${s.minutes} 分钟`
        : s.kind === 'once'
          ? `单次 ${date(s.at)}`
          : `${s.kind === 'daily' ? '每天' : '每周 ' + s.weekdays.map((v) => '日一二三四五六'[v]).join('、')} ${s.time} · ${s.timezone}`;
  return (
    <div className="automation-center">
      <nav className="automation-tabs" aria-label="自动化分区">
        {(
          [
            ['flows', '处理流程'],
            ['rules', '自动化与定时'],
            ['jobs', '任务与结果'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'selected' : ''}
            title={
              id === 'flows'
                ? '保存常用处理要求，供文档、目录或定时规则使用'
                : id === 'rules'
                  ? '设置触发条件或运行时间'
                  : '查看独立执行记录，核对内容处理生成的草稿'
            }
            onClick={() => {
              setTab(id);
              setRule(undefined);
              setFlow(undefined);
            }}
          >
            {label}
            {id === 'jobs' &&
            state.jobs.some((j) => !j.reviewedAt && ['completed', 'failed'].includes(j.status))
              ? ' · 有新结果'
              : ''}
          </button>
        ))}
      </nav>
      <p className="muted">任务在本机运行，请保持同舟开启。</p>
      {error && (
        <p role="alert" className="danger">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {tab === 'flows' && !flow && (
        <>
          <div className="automation-heading">
            <h2>处理流程</h2>
            <button
              className="primary"
              title="保存常用处理要求，再绑定文档、目录或定时规则"
              onClick={() => setFlow({ name: '', prompt: '', ...connection() })}
            >
              新建流程
            </button>
          </div>
          {!state.flows.length && (
            <div className="automation-empty">
              <strong>从一个通用处理流程开始</strong>
              <p>例如摘要、提取要点、校对、改写。具体领域由提示词、技能和 Agent 定义。</p>
              <button
                onClick={() =>
                  setFlow({
                    name: '摘要与要点',
                    prompt:
                      '基于输入资料生成简明摘要、关键要点与待核对事项。保留原意，不补造事实。直接输出可保存的 Markdown 正文。',
                    ...connection(),
                  })
                }
              >
                使用摘要模板
              </button>
            </div>
          )}
          <div className="automation-cards">
            {state.flows.map((f) => (
              <article key={f.id}>
                <h3>
                  {f.name} <small>v{f.version}</small>
                </h3>
                <p className="automation-excerpt">{f.prompt}</p>
                <small>{f.model}</small>
                <div className="row">
                  <button onClick={() => setFlow(f)}>编辑流程</button>
                  <button
                    disabled={busy}
                    onClick={() => void action(() => api.contentFlowDelete(f.id))}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {flow && (
        <form
          className="automation-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api.contentFlowSave(flow);
              setFlow(undefined);
            });
          }}
        >
          <fieldset disabled={busy}>
            <h2>{flow.id ? '编辑处理流程' : '新建处理流程'}</h2>
            <Field label="流程名称">
              <input
                required
                maxLength={100}
                aria-label="流程名称"
                value={flow.name}
                onChange={(e) => setFlow({ ...flow, name: e.target.value })}
              />
            </Field>
            <Field label="处理要求">
              <textarea
                required
                maxLength={16000}
                rows={7}
                aria-label="处理要求"
                value={flow.prompt}
                onChange={(e) => setFlow({ ...flow, prompt: e.target.value })}
              />
            </Field>
            <ModelAgentFields
              data={data}
              value={flow}
              onChange={(p) => setFlow({ ...flow, ...p })}
            />
            <p className="muted">
              可在处理要求中指定已启用的技能。保存后的修改只影响后续入队任务。
            </p>
            <div className="row">
              <button className="primary" type="submit">
                保存流程
              </button>
              <button type="button" onClick={() => setFlow(undefined)}>
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {tab === 'rules' && !rule && (
        <>
          <div className="automation-heading">
            <h2>自动化任务</h2>
            <div className="row">
              <button onClick={() => newRule('content')}>新建内容自动化</button>
              <button className="primary" onClick={() => newRule('task')}>
                新建定时任务
              </button>
            </div>
          </div>
          {!state.rules.length && (
            <div className="automation-empty">
              还没有自动化。内容自动化可处理导入资料，定时任务可独立执行提示词或检查项目。
            </div>
          )}
          <div className="automation-cards">
            {state.rules.map((r) => (
              <article key={r.id}>
                <h3 title={capability(r.kind)?.description}>
                  {r.name}
                  {capability(r.kind)?.builtinRuleId === r.id && <small> · 内置</small>}
                </h3>
                <p>
                  {capability(r.kind)?.name ?? r.kind} · {triggers[r.trigger]} ·{' '}
                  {r.enabled ? '已启用' : '已暂停'}
                </p>
                {r.trigger === 'schedule' && (
                  <>
                    <p>{scheduleLabel(r.schedule)}</p>
                    <small>下次执行：{date(r.nextRunAt)}</small>
                  </>
                )}
                {r.error && <p className="danger">{r.error}</p>}
                <div className="row">
                  <button
                    disabled={busy || (!!capability(r.kind)?.builtinRuleId && !r.enabled)}
                    title={
                      r.trigger === 'idle'
                        ? '有新内容时加入队列，当前任务结束后执行'
                        : '立即加入执行队列'
                    }
                    onClick={() =>
                      void action(async () => {
                        const result = await api.automationRun(r.id);
                        setNotice(
                          result.queued
                            ? '已加入执行队列，可在任务与结果中查看'
                            : (result.reason ?? '没有新增任务'),
                        );
                      })
                    }
                  >
                    立即运行
                  </button>
                  <button onClick={() => setRule(r)}>编辑</button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(() => api.automationSave({ ...r, enabled: !r.enabled }))
                    }
                  >
                    {r.enabled ? '暂停' : '启用'}
                  </button>
                  {!capability(r.kind)?.builtinRuleId && (
                    <button
                      disabled={busy}
                      onClick={() => void action(() => api.automationDelete(r.id))}
                    >
                      删除
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {rule && (
        <form
          className="automation-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api.automationSave(rule);
              setRule(undefined);
            });
          }}
        >
          <fieldset disabled={busy}>
            <h2>
              {rule.id ? '编辑' : '新建'}
              {capability(rule.kind)?.builtinRuleId
                ? capability(rule.kind)?.name
                : rule.kind === 'content'
                  ? '内容自动化'
                  : '定时任务'}
            </h2>
            <Field label="任务名称">
              <input
                required
                maxLength={100}
                aria-label="任务名称"
                value={rule.name}
                onChange={(e) => setRule({ ...rule, name: e.target.value })}
              />
            </Field>
            {rule.kind === 'content' ? (
              <>
                <div className="automation-grid">
                  <Field label="处理流程">
                    <select
                      required
                      aria-label="处理流程"
                      value={rule.flowId ?? ''}
                      onChange={(e) => setRule({ ...rule, flowId: e.target.value })}
                    >
                      <option value="">请选择流程</option>
                      {state.flows.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="目标内容库">
                    <select
                      aria-label="目标内容库"
                      value={rule.libraryId}
                      onChange={(e) =>
                        setRule({
                          ...rule,
                          libraryId: e.target.value,
                          folderId: undefined,
                          documentId: undefined,
                          outputFolderId: undefined,
                        })
                      }
                    >
                      {libraries.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="automation-grid">
                  <Field label="输入目录">
                    <select
                      aria-label="输入目录"
                      value={rule.folderId ?? ''}
                      onChange={(e) =>
                        setRule({
                          ...rule,
                          folderId: e.target.value || undefined,
                          documentId: undefined,
                        })
                      }
                    >
                      <option value="">全部目录</option>
                      {contents?.folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {knowledgeFolderPath(contents.folders, f.id)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="输入文档">
                    <select
                      aria-label="输入文档"
                      value={rule.documentId ?? ''}
                      onChange={(e) =>
                        setRule({ ...rule, documentId: e.target.value || undefined })
                      }
                    >
                      <option value="">范围内原始文档（每篇单独处理）</option>
                      {contents?.documents
                        .filter((d) => !rule.folderId || d.folderId === rule.folderId)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.title}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="输出目录">
                    <select
                      aria-label="输出目录"
                      value={rule.outputFolderId ?? ''}
                      onChange={(e) =>
                        setRule({ ...rule, outputFolderId: e.target.value || undefined })
                      }
                    >
                      <option value="">未分类</option>
                      {contents?.folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {knowledgeFolderPath(contents.folders, f.id)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <p className="muted">
                  目录只匹配当前层级。批量处理默认排除派生文档，防止结果反复触发；指定单篇时可继续加工派生文档。
                </p>
              </>
            ) : rule.kind === 'task' ? (
              <>
                <Field label="完成后发送到">
                  <select
                    aria-label="完成后发送到"
                    value={rule.notificationTargetId ?? ''}
                    onChange={(e) =>
                      setRule({ ...rule, notificationTargetId: e.target.value || undefined })
                    }
                  >
                    <option value="">不发送</option>
                    {[
                      ...(data.notificationTargets ?? []),
                      ...(data.channels ?? []).map((c) => ({
                        id: c.id,
                        name: c.name,
                        available: c.enabled,
                      })),
                    ].map((t) => (
                      <option key={t.id} value={t.id} disabled={!t.available}>
                        {t.name}
                        {!t.available ? '（不可用）' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="任务指令">
                  <textarea
                    required
                    maxLength={16000}
                    rows={6}
                    aria-label="任务指令"
                    value={rule.prompt ?? ''}
                    onChange={(e) => setRule({ ...rule, prompt: e.target.value })}
                  />
                </Field>
                <ModelAgentFields
                  data={data}
                  value={rule}
                  onChange={(p) => setRule({ ...rule, ...p })}
                />
                <div className="automation-grid">
                  <Field label="关联项目">
                    <select
                      aria-label="关联项目"
                      value={rule.projectId ?? ''}
                      onChange={(e) => setRule({ ...rule, projectId: e.target.value || undefined })}
                    >
                      <option value="">不关联项目</option>
                      {data.projects
                        .filter((p) => !p.removed)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="执行权限">
                    <select
                      aria-label="执行权限"
                      value={rule.permission}
                      onChange={(e) =>
                        setRule({ ...rule, permission: e.target.value as 'ask' | 'read-only' })
                      }
                    >
                      <option value="read-only">只读检查</option>
                      <option value="ask">修改前询问</option>
                    </select>
                  </Field>
                </div>
                <p className="muted">
                  每次在独立会话中执行。需要批准操作时，在执行会话中处理；项目任务使用原项目目录。
                </p>
              </>
            ) : (
              <p className="muted">{capability(rule.kind)?.description} 整理会消耗所选模型额度。</p>
            )}
            <Field label="触发方式">
              <select
                aria-label="触发方式"
                value={rule.trigger}
                onChange={(e) =>
                  setRule({
                    ...rule,
                    trigger: e.target.value as AutomationInput['trigger'],
                    schedule: rule.schedule ?? defaultSchedule(),
                  })
                }
              >
                {Object.entries(triggers)
                  .filter(([key]) =>
                    (capability(rule.kind)?.triggers ?? ['manual', 'schedule']).includes(
                      key as AutomationInput['trigger'],
                    ),
                  )
                  .map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
              </select>
            </Field>
            {rule.trigger === 'schedule' && schedule && (
              <ScheduleFields
                schedule={schedule}
                missed={rule.missed}
                setSchedule={setSchedule}
                onMissed={(missed) => setRule({ ...rule, missed })}
              />
            )}
            <label>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => setRule({ ...rule, enabled: e.target.checked })}
              />
              启用此规则
            </label>
            <div className="row">
              <button className="primary" type="submit">
                保存任务
              </button>
              <button type="button" onClick={() => setRule(undefined)}>
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {tab === 'jobs' && (
        <>
          <div className="automation-heading">
            <p title="后台同时执行一个任务；记忆整理最长 3 分钟，其他任务最长 30 分钟">
              最近 200 次执行
            </p>
            <select
              aria-label="任务状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="unread">待查看</option>
              {Object.entries(statuses).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="automation-jobs">
            <div className="automation-job-list">
              {state.jobs
                .filter(
                  (j) =>
                    filter === 'all' ||
                    (filter === 'unread'
                      ? !j.reviewedAt && ['completed', 'failed'].includes(j.status)
                      : j.status === filter),
                )
                .map((j) => (
                  <button
                    key={j.id}
                    className={selected === j.id ? 'selected' : ''}
                    onClick={() => setSelected(j.id)}
                  >
                    <strong>{j.rule.name}</strong>
                    <span>
                      {statuses[j.status]} · 第 {j.attempt} 次尝试
                    </span>
                    <small>{date(j.createdAt)}</small>
                  </button>
                ))}
              {!state.jobs.length && <p className="muted">执行结果会出现在这里。</p>}
            </div>
            <article className="automation-result">
              {job ? (
                <>
                  <h2>{job.rule.name}</h2>
                  <p>
                    {statuses[job.status]} · {date(job.startedAt ?? job.createdAt)}
                  </p>
                  {job.flow && (
                    <p className="muted">
                      流程：{job.flow.name} v{job.flow.version}
                    </p>
                  )}
                  <div className="row">
                    {['queued', 'running'].includes(job.status) && (
                      <button
                        disabled={busy}
                        onClick={() => void action(() => api.automationCancel(job.id))}
                      >
                        停止执行
                      </button>
                    )}
                    {['failed', 'cancelled'].includes(job.status) && (
                      <button
                        disabled={busy}
                        onClick={() => void action(() => api.automationRetry(job.id))}
                      >
                        重试
                      </button>
                    )}
                    {job.sessionId && onSession && job.rule.kind !== 'memory' && (
                      <button
                        onClick={() =>
                          void action(async () => {
                            const snapshot = await api.snapshot();
                            const s = snapshot.sessions.find((s) => s.id === job.sessionId);
                            if (!s) throw new Error('执行会话已删除');
                            onSession(s);
                          })
                        }
                      >
                        打开执行会话
                      </button>
                    )}
                    {job.outputId && (
                      <>
                        {job.rule.kind !== 'memory' && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                const r = await api.knowledgeRead(job.outputId!);
                                await api.knowledgeReview(r.document.id, r.document.version);
                                setNotice('派生草稿已核对收录');
                              })
                            }
                          >
                            核对收录
                          </button>
                        )}
                        {onDocument && (
                          <button
                            onClick={() => onDocument(job.outputId!, job.rule.libraryId ?? '')}
                          >
                            {job.rule.kind === 'memory' ? '查看记忆' : '打开派生文档'}
                          </button>
                        )}
                      </>
                    )}
                    {!job.reviewedAt &&
                      ['completed', 'failed', 'cancelled'].includes(job.status) && (
                        <button
                          disabled={busy}
                          onClick={() => void action(() => api.automationReview(job.id))}
                        >
                          标为已查看
                        </button>
                      )}
                  </div>
                  {job.source && (
                    <p className="muted">
                      来源：{job.source.title} · v{job.source.version}
                      {job.sourceState === 'changed'
                        ? ' · 原文已更新，可重新运行生成新草稿'
                        : job.sourceState === 'missing'
                          ? ' · 原文已删除，保留本次来源记录'
                          : ''}
                    </p>
                  )}
                  {job.error && <p className="danger">{job.error}</p>}
                  {job.result && <Markdown text={job.result} />}
                  {(job.flow?.prompt || job.rule.prompt) && (
                    <details>
                      <summary>本次任务指令</summary>
                      <pre>{job.flow?.prompt ?? job.rule.prompt}</pre>
                    </details>
                  )}
                </>
              ) : (
                <p className="muted">选择一次执行，查看结果与处理记录。</p>
              )}
            </article>
          </div>
        </>
      )}
    </div>
  );
}
