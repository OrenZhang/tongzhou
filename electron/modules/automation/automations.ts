import type { TaskService, ChangePublisher } from '../../core/task-contracts';
import type { DomainServices } from '../domain-services';
import { MEMORY_AUTOMATION_ID } from '../../../src/shared/automation';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../services/storage/store';
import type { Run, Session } from '../../../src/shared/types';
import type {
  AutomationRule,
  AutomationJob,
  AutomationState,
  ContentFlow,
  TaskSchedule,
} from '../../../src/shared/automation';
import { libraryIdSchema } from '../content/content';
import {
  AutomationHandlers,
  assertAutomationConnection,
  builtinAutomationHandlers,
} from './automation-handlers';

const text = z.string().trim().min(1);
export const flowSchema = z.object({
  id: z.string().uuid().optional(),
  version: z.number().int().positive().optional(),
  name: text.max(100),
  prompt: text.max(16000),
  providerId: text.max(120),
  model: text.max(200),
  agentId: z.string().max(120).optional(),
});
export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.number().int().positive().max(8640000000000000) }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(525600) }),
  z.object({
    kind: z.enum(['daily', 'weekly']),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: text.max(100).refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, '无效时区'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
]);
export const automationSchema = z.object({
  id: z.string().uuid().optional(),
  version: z.number().int().positive().optional(),
  name: text.max(100),
  enabled: z.boolean(),
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  trigger: z.enum(['manual', 'import', 'ready', 'schedule', 'idle']),
  flowId: z.string().uuid().optional(),
  libraryId: libraryIdSchema.optional(),
  folderId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  outputFolderId: z.string().uuid().optional(),
  prompt: text.max(16000).optional(),
  providerId: text.max(120).optional(),
  model: text.max(200).optional(),
  agentId: z.string().max(120).optional(),
  projectId: z.string().uuid().optional(),
  permission: z.enum(['read-only', 'ask']).default('read-only'),
  schedule: scheduleSchema.optional(),
  missed: z.enum(['once', 'skip']).default('once'),
});

/** Calendar schedules use their saved IANA timezone, including DST transitions. */
export function nextSchedule(
  s: TaskSchedule,
  after: number,
  lastOccurrence = after,
): number | undefined {
  if (s.kind === 'once') return s.at > after ? s.at : undefined;
  if (s.kind === 'interval') return after + s.minutes * 60000;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: s.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = (at: number) =>
    Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const prev = parts(lastOccurrence);
  const dateKey = (p: Record<string, string>) => `${p.year}-${p.month}-${p.day}`;
  for (
    let at = Math.floor(after / 60000) * 60000 + 60000;
    at <= after + 8 * 86400000;
    at += 60000
  ) {
    const p = parts(at);
    if (`${p.hour}:${p.minute}` !== s.time) continue;
    // During a repeated DST hour, run this wall-clock occurrence only once.
    if (dateKey(p) === dateKey(prev) && `${prev.hour}:${prev.minute}` >= s.time) continue;
    if (
      s.kind === 'daily' ||
      s.weekdays.includes(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday))
    )
      return at;
  }
  throw new Error('无法计算下一次执行时间');
}

export class Automations {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private lastIdleCheck = -Infinity;
  constructor(
    private store: Store,
    private runtime: Pick<TaskService, 'start' | 'cancel'> &
      ChangePublisher &
      Pick<DomainServices, 'content' | 'knowledge'>,
    private now = () => Date.now(),
    readonly handlers: AutomationHandlers = builtinAutomationHandlers(store, runtime),
  ) {
    store.db.exec(
      "CREATE INDEX IF NOT EXISTS automation_job_status ON objects(json_extract(value,'$.status')) WHERE kind='automationJob'; CREATE INDEX IF NOT EXISTS automation_job_key ON objects(json_extract(value,'$.key')) WHERE kind='automationJob'",
    );
    for (const handler of this.handlers.all()) {
      const rule = handler.defaults?.();
      if (rule && !store.list<AutomationRule>('automation').some((r) => r.id === rule.id))
        store.put('automation', rule);
    }
    // Running work is never blindly replayed after a crash; queued snapshots remain resumable.
    for (const job of this.jobs().filter((j) => j.status === 'running')) {
      const run = job.runId ? store.list<Run>('run').find((r) => r.id === job.runId) : undefined;
      if (run?.status === 'completed' || this.handlers.get(job.rule.kind).committed?.(job))
        this.finish(job, run);
      else
        this.fail({
          ...job,
          status: 'failed',
          error: '应用退出导致任务中断，可检查结果后重试。',
          endedAt: this.now(),
        });
    }
  }
  start() {
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  processMemory(retry = false) {
    if (this.stopped) return { started: false };
    return {
      started:
        this.run(MEMORY_AUTOMATION_ID, `${retry ? 'manual' : 'requested'}:${randomUUID()}`).queued >
        0,
    };
  }
  private jobs() {
    return (
      this.store.db
        .prepare(
          "SELECT value FROM objects WHERE kind='automationJob' AND json_extract(value,'$.status') IN ('queued','running') ORDER BY rowid",
        )
        .all() as { value: string }[]
    ).map((r) => JSON.parse(r.value) as AutomationJob);
  }
  private putJob(j: AutomationJob) {
    this.store.put('automationJob', j);
  }
  private fail(job: AutomationJob) {
    this.handlers.get(job.rule.kind).settled?.(job, job.error ?? '任务已停止');
    this.putJob(job);
  }
  state(): AutomationState {
    return {
      capabilities: this.handlers.capabilities(),
      flows: this.store.list('contentFlow'),
      rules: this.store.list('automation'),
      jobs: (
        this.store.db
          .prepare(
            "SELECT json_remove(value,'$.source.content','$.result') AS value FROM objects WHERE kind='automationJob' ORDER BY rowid DESC LIMIT 200",
          )
          .all() as { value: string }[]
      ).map((r) => JSON.parse(r.value)),
    };
  }
  readJob(id: string) {
    const { source, ...job } = this.store.get<AutomationJob>('automationJob', id);
    if (!source) return job;
    const { content, ...reference } = source;
    return {
      ...job,
      source: reference,
      sourceState: this.handlers
        .get(job.rule.kind)
        .sourceState?.(this.store.get<AutomationJob>('automationJob', id)),
    };
  }
  private connection(p: { providerId?: string; model?: string; agentId?: string }) {
    assertAutomationConnection(this.store, p);
  }
  saveFlow(raw: unknown) {
    const p = flowSchema.parse(raw),
      old = p.id ? this.store.get<ContentFlow>('contentFlow', p.id) : undefined;
    if (old && old.version !== p.version) throw new Error('流程已更新，请刷新');
    this.connection(p);
    const flow = { ...p, id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1 };
    this.store.put('contentFlow', flow);
    this.runtime.changed();
    return flow;
  }
  deleteFlow(id: string) {
    if (this.store.list<AutomationRule>('automation').some((r) => r.flowId === id))
      throw new Error('请先删除引用此流程的自动化');
    this.store.remove('contentFlow', id);
    this.runtime.changed();
  }
  private validate(r: AutomationRule) {
    const handler = this.handlers.get(r.kind);
    if (handler.capability && !handler.capability.triggers.includes(r.trigger))
      throw new Error('该任务不支持此触发方式');
    handler.validate(r);
    if (r.trigger === 'schedule' && !r.schedule) throw new Error('请设置执行时间');
  }
  save(raw: unknown) {
    const p = automationSchema.parse(raw),
      old = p.id ? this.store.get<AutomationRule>('automation', p.id) : undefined;
    if (old && old.version !== p.version) throw new Error('自动化已更新，请刷新');
    const r: AutomationRule = {
      ...p,
      id: old?.id ?? randomUUID(),
      version: (old?.version ?? 0) + 1,
      createdAt: old?.createdAt ?? this.now(),
    };
    const handler = this.handlers.get(r.kind);
    if (old && old.kind !== r.kind) throw new Error('不能更改任务类型');
    if (handler.capability?.builtinRuleId && handler.capability.builtinRuleId !== r.id)
      throw new Error('请编辑现有内置任务，不能重复创建');
    if (handler.capability?.builtinRuleId) handler.validate(r);
    if (r.enabled) this.validate(r);
    if (r.trigger === 'schedule' && r.enabled) {
      r.nextRunAt =
        old?.enabled &&
        old.trigger === 'schedule' &&
        old.nextRunAt &&
        JSON.stringify(old.schedule) === JSON.stringify(r.schedule)
          ? old.nextRunAt
          : nextSchedule(r.schedule!, this.now());
      if (!r.nextRunAt) throw new Error('请选择未来的执行时间');
    }
    this.store.put('automation', r);
    if (!r.enabled)
      for (const job of this.jobs().filter((j) => j.rule.id === r.id && j.status === 'queued'))
        this.putJob({ ...job, status: 'cancelled', endedAt: this.now(), error: '自动化已暂停' });
    if (!r.enabled && handler.capability?.builtinRuleId)
      for (const job of this.jobs().filter((j) => j.rule.id === r.id && j.status === 'running'))
        void this.cancel(job.id);
    this.runtime.changed();
    return r;
  }
  delete(id: string) {
    const rule = this.store.get<AutomationRule>('automation', id);
    if (this.handlers.get(rule.kind).capability?.builtinRuleId === id)
      throw new Error('内置任务可以暂停，不能删除');
    if (this.jobs().some((j) => j.rule.id === id && ['queued', 'running'].includes(j.status)))
      throw new Error('请先停止该自动化的待执行任务');
    this.store.remove('automation', id);
    this.runtime.changed();
  }
  private enqueue(rule: AutomationRule, occurrence: string, sourceId?: string) {
    this.validate(rule);
    const { source, flow } = this.handlers.get(rule.kind).capture(rule, sourceId);
    const key = JSON.stringify([
      rule.id,
      rule.version,
      flow?.version,
      occurrence,
      source?.id,
      source?.version,
    ]);
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM objects WHERE kind='automationJob' AND json_extract(value,'$.key')=?",
        )
        .get(key)
    )
      return;
    if (this.jobs().filter((j) => j.status === 'queued').length >= 200)
      throw new Error('待执行任务已达 200 个，请先处理队列');
    const job: AutomationJob = {
      id: randomUUID(),
      key,
      rule,
      flow,
      source: source
        ? {
            id: source.id,
            version: source.version,
            title: source.title,
            content: source.content,
            projectId: source.projectId,
          }
        : undefined,
      status: 'queued',
      createdAt: this.now(),
      attempt: 1,
      manual: occurrence.startsWith('manual:'),
    };
    this.putJob(job);
    return job.id;
  }
  run(id: string, occurrence = 'manual:' + randomUUID()) {
    const rule = this.store.get<AutomationRule>('automation', id);
    this.validate(rule);
    const handler = this.handlers.get(rule.kind);
    if (handler.capability?.builtinRuleId && this.jobs().some((j) => j.rule.id === id))
      return { queued: 0, reason: '该任务已在队列中' };
    const ids = handler.inputIds(rule, occurrence.startsWith('manual:'));
    if (!ids.length) {
      if (handler.capability?.builtinRuleId) return { queued: 0, reason: '没有需要处理的新内容' };
      throw new Error('当前范围没有可处理的正文；派生文档请显式指定');
    }
    if (ids.length > 100) throw new Error('单次最多处理 100 篇，请缩小目录范围');
    this.store.db.exec('BEGIN');
    let queued = 0;
    try {
      for (const id of ids) if (this.enqueue(rule, occurrence, id)) queued++;
      this.store.db.exec('COMMIT');
    } catch (e) {
      this.store.db.exec('ROLLBACK');
      throw e;
    }
    this.runtime.changed();
    return { queued };
  }
  event(type: 'import' | 'ready', id: string) {
    for (const r of this.store
      .list<AutomationRule>('automation')
      .filter((r) => r.enabled && r.trigger === type)) {
      try {
        if (!this.handlers.get(r.kind).matchesEvent?.(r, { type, id })) continue;
        this.enqueue(r, type, id);
        this.store.put('automation', { ...r, error: undefined });
      } catch (e) {
        this.store.put('automation', { ...r, error: String(e) });
      }
    }
    this.runtime.changed();
  }
  async cancel(id: string) {
    const j = this.store.get<AutomationJob>('automationJob', id);
    if (!['queued', 'running'].includes(j.status)) return;
    this.fail({ ...j, status: 'cancelled', endedAt: this.now() });
    if (j.sessionId) await this.runtime.cancel(j.sessionId);
    this.runtime.changed();
  }
  retry(id: string) {
    const j = this.store.get<AutomationJob>('automationJob', id);
    if (!['failed', 'cancelled'].includes(j.status)) throw new Error('仅失败或取消的任务可以重试');
    const rule = this.store.get<AutomationRule>('automation', j.rule.id);
    this.validate(j.rule);
    const handler = this.handlers.get(rule.kind);
    if (handler.committed?.(j)) {
      this.finish(j);
      this.runtime.changed();
      return;
    }
    if (handler.capability?.builtinRuleId) {
      if (!rule.enabled) throw new Error('内置任务已暂停，请先启用');
      if (this.jobs().some((v) => v.rule.id === rule.id && v.id !== id))
        throw new Error('该任务已在队列中');
    }
    handler.retry?.(j);
    this.putJob({
      ...j,
      manual: true,
      status: 'queued',
      attempt: j.attempt + 1,
      sessionId: undefined,
      runId: undefined,
      error: undefined,
      startedAt: undefined,
      endedAt: undefined,
    });
    this.runtime.changed();
  }
  review(id: string) {
    const j = this.store.get<AutomationJob>('automationJob', id);
    this.putJob({ ...j, reviewedAt: this.now() });
    this.runtime.changed();
  }
  private finish(job: AutomationJob, run?: Run) {
    try {
      const handler = this.handlers.get(job.rule.kind);
      if (run?.status !== 'completed' && !handler.committed?.(job))
        throw new Error(run?.error || '任务已中断');
      const result =
        this.store
          .messages(run?.sessionId ?? job.sessionId!)
          .findLast(
            (m) =>
              m.runId === run?.id &&
              m.role === 'assistant' &&
              m.status === 'complete' &&
              !m.toolCalls?.length &&
              m.content.trim(),
          )?.content ?? '';
      if (!result.trim() && !handler.allowEmptyResult) throw new Error('没有生成可用结果');
      const outputId = handler.complete(job, result);
      this.putJob({
        ...job,
        status: 'completed',
        result: handler.summarize?.(job, result) ?? result,
        outputId,
        endedAt: this.now(),
      });
    } catch (e) {
      this.fail({ ...job, status: 'failed', error: String(e), endedAt: this.now() });
    }
  }
  tick() {
    if (this.stopped) return;
    let changed = false;
    for (const j of this.jobs().filter((j) => j.status === 'running')) {
      const r = this.store.list<Run>('run').find((r) => r.id === j.runId);
      if (r && r.status !== 'running') {
        this.finish(j, r);
        changed = true;
      } else if (
        this.now() - j.startedAt! >
        (this.handlers.get(j.rule.kind).timeoutMs ?? 30 * 60000)
      ) {
        if (j.sessionId) void this.runtime.cancel(j.sessionId);
        this.fail({
          ...j,
          status: 'failed',
          error: `超过 ${(this.handlers.get(j.rule.kind).timeoutMs ?? 30 * 60000) / 60000} 分钟，已停止，可检查后重试`,
          endedAt: this.now(),
        });
        changed = true;
      }
    }
    for (const r of this.store
      .list<AutomationRule>('automation')
      .filter(
        (r) => r.enabled && r.trigger === 'schedule' && r.nextRunAt && r.nextRunAt <= this.now(),
      )) {
      try {
        if (
          !this.jobs().some(
            (j) => j.rule.id === r.id && ['queued', 'running'].includes(j.status),
          ) &&
          (r.missed === 'once' || this.now() - r.nextRunAt! < 60000)
        )
          this.run(r.id, 'schedule:' + r.nextRunAt);
        const nextRunAt = nextSchedule(r.schedule!, this.now(), r.nextRunAt);
        const builtin = !!this.handlers.get(r.kind).capability?.builtinRuleId;
        this.store.put('automation', {
          ...r,
          nextRunAt,
          enabled: builtin || !!nextRunAt,
          trigger: builtin && !nextRunAt ? 'manual' : r.trigger,
          error: undefined,
        });
      } catch (e) {
        this.store.put('automation', { ...r, enabled: false, error: String(e) });
      }
      changed = true;
    }
    if (this.now() - this.lastIdleCheck >= 30000) {
      this.lastIdleCheck = this.now();
      for (const r of this.store
        .list<AutomationRule>('automation')
        .filter((r) => r.enabled && r.trigger === 'idle')) {
        try {
          this.run(r.id, 'idle:' + this.now());
        } catch (e) {
          this.store.put('automation', { ...r, error: String(e) });
          changed = true;
        }
      }
    }
    // One background automation at a time; leave capacity for interactive work.
    if (
      !this.jobs().some((j) => j.status === 'running') &&
      this.store.list<Run>('run').filter((r) => r.status === 'running').length < 3
    ) {
      let j = this.jobs().find(
        (j) => j.status === 'queued' && (this.handlers.get(j.rule.kind).canRun?.(j) ?? true),
      );
      if (j) {
        try {
          const handler = this.handlers.get(j.rule.kind);
          const prepared = handler.prepare(j);
          if (!prepared) {
            // No new input is a quiet skip, not a model run or a failed task.
            if (j.attempt > 1)
              this.fail({
                ...j,
                status: 'cancelled',
                error: '来源已处理或不可用，无需重复执行',
                endedAt: this.now(),
              });
            else this.store.remove('automationJob', j.id);
            this.runtime.changed();
            return;
          }
          j = { ...j, context: prepared.context };
          this.putJob(j);
          const config = prepared.config;
          assertAutomationConnection(this.store, config, handler.allowBuiltinAgent);
          const prompt = prepared.prompt;
          if (prompt.length > 100000) throw new Error('输入资料过长，请先拆分为较小文档再处理');
          const s = this.store.createSession(prepared.session.projectId ?? undefined);
          const session: Session = {
            ...s,
            ...prepared.session,
            id: s.id,
            title: `自动化 · ${j.rule.name}`,
            automationJob: j.id,
          };
          this.store.put('session', session);
          j = { ...j, status: 'running', startedAt: this.now(), sessionId: s.id };
          this.putJob(j);
          handler.started?.(j);
          const runId = this.runtime.start({
            sessionId: s.id,
            providerId: config.providerId!,
            model: config.model!,
            agentId: config.agentId ?? '',
            prompt,
          });
          this.putJob({ ...j, runId });
        } catch (e) {
          this.fail({ ...j, status: 'failed', error: String(e), endedAt: this.now() });
        }
        changed = true;
      }
    }
    if (changed) this.runtime.changed();
  }
}
