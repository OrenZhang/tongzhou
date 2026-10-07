import { MEMORY_AUTOMATION_ID } from '../../../src/shared/automation';
import { MEMORY_ORGANIZER_ID } from '../../../src/shared/builtin-agents';
import type { Run } from '../../../src/shared/types';
import type { AutomationHandler } from './automation-handlers';
import type { MemoryJob } from '../knowledge/knowledge-memory';
import type { Runtime } from '../../core/runtime/runtime';
import type { Store } from '../../services/storage/store';
import { agentConnection, agentProfile } from '../agents/agents';

/** Memory owns evidence and commits; the shared scheduler owns triggers and run lifecycle. */
export function memoryAutomationHandler(
  store: Store,
  runtime: Pick<Runtime, 'knowledge'>,
): AutomationHandler {
  const memory = runtime.knowledge.memory;
  const jobMemory = (context?: Record<string, string>) =>
    context?.memoryJobId
      ? store.get<MemoryJob>('knowledgeMemoryJob', context.memoryJobId)
      : undefined;
  return {
    kind: 'memory',
    capability: {
      kind: 'memory',
      name: '记忆整理',
      description:
        '从已完成会话中提炼有来源的每日记忆；默认跟随记忆整理 Agent 的模型设置，未设置时使用来源会话模型。',
      triggers: ['idle', 'schedule', 'manual'],
      builtinRuleId: MEMORY_AUTOMATION_ID,
    },
    defaults: () => ({
      id: MEMORY_AUTOMATION_ID,
      version: 1,
      name: '记忆整理',
      kind: 'memory',
      enabled: runtime.knowledge.settings().autoCollect,
      trigger: 'idle',
      permission: 'read-only',
      missed: 'once',
      createdAt: Date.now(),
    }),
    timeoutMs: 180000,
    allowBuiltinAgent: MEMORY_ORGANIZER_ID,
    allowEmptyResult: true,
    committed: (job) => jobMemory(job.context)?.status === 'committed',
    validate(rule) {
      if (rule.id !== MEMORY_AUTOMATION_ID)
        throw new Error('记忆整理使用唯一的内置任务，请编辑现有任务');
      if (rule.permission !== 'read-only') throw new Error('记忆整理仅允许读取候选来源并提交记忆');
    },
    canRun: () => !store.list<Run>('run').some((r) => r.status === 'running'),
    inputIds(_rule, manual) {
      if (!runtime.knowledge.settings().autoCollect) throw new Error('记忆整理已暂停，请先启用');
      if (manual) memory.retry();
      return memory.eligible(!!manual).length ? [undefined] : [];
    },
    capture: () => ({}),
    prepare(job) {
      if (!runtime.knowledge.settings().autoCollect) throw new Error('记忆整理已暂停');
      const previous = jobMemory(job.context);
      const first = memory
        .eligible(!!job.manual)
        .find((c) => !previous || previous.candidateIds.includes(c.id));
      if (!first) return;
      const config = agentConnection(store, agentProfile(store, MEMORY_ORGANIZER_ID), first);
      const work = memory.claim(!!job.manual, previous?.candidateIds);
      if (!work) return;
      return {
        config: { ...config, agentId: MEMORY_ORGANIZER_ID },
        prompt: work.prompt,
        context: { memoryJobId: work.job.id },
        session: {
          projectId: work.candidate.projectId ?? null,
          knowledgeJob: true,
          memoryJob: work.job.id,
          permission: 'read-only',
          ...config,
          agentId: MEMORY_ORGANIZER_ID,
        },
      };
    },
    started(job) {
      const m = jobMemory(job.context);
      if (m) store.put('knowledgeMemoryJob', { ...m, sessionId: job.sessionId });
    },
    complete(job) {
      const m = jobMemory(job.context);
      if (m?.status !== 'committed') throw new Error('模型结束但未提交结构化记忆，请重试');
      return runtime.knowledge.all().find((d) => d.memoryDate === m.day)?.id;
    },
    summarize(job) {
      const m = jobMemory(job.context)!;
      return (
        `已处理 ${m.candidateIds.length} 个会话轮次，新增 ${m.saved ?? 0} 条记忆。` +
        (m.skippedReason ? `\n\n${m.skippedReason}` : `\n\n归档日期：${m.day}`)
      );
    },
    settled(job, error) {
      const m = jobMemory(job.context);
      if (m) memory.fail(m.id, error);
    },
    retry(job) {
      const m = jobMemory(job.context);
      if (m) memory.retry(m.candidateIds);
    },
  };
}
