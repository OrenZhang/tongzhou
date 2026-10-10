import type { DomainServices } from '../domain-services';
import type { Automations } from '../automation/automations';
import type { Store } from '../../services/storage/store';
import { z } from 'zod';
import {
  workspaceOperation,
  operation,
  type ClientOperation,
} from '../../core/tools/client-commands';
import { automationSchema, flowSchema } from './automations';
import type { Session } from '../../../src/shared/types';
import type { AutomationRule, AutomationJob } from '../../../src/shared/automation';
import type { MemoryJob } from '../knowledge/knowledge-memory';
import { projectFamilyId } from '../../../src/shared/projects';
export function registerAutomationServices(
  register: (name: string, definition: ClientOperation, handler: (...args: any[]) => any) => void,
  services: Pick<DomainServices, 'knowledge'> & { automations: Automations; store: Store },
) {
  const a = services.automations,
    id = z.string().uuid();
  const interactive = (sessionId: string) => {
    const s = services.store.get<Session>('session', sessionId);
    if (s.automationJob || s.memoryJob || s.parentId || s.knowledgeJob || s.contentContext)
      throw new Error('请在普通会话中管理自动化，后台任务不能递归创建或触发其他任务');
    return s;
  };
  const accessibleRule = (rule: AutomationRule, sessionId: string) => {
    const s = services.store.get<Session>('session', sessionId);
    if (
      rule.projectId &&
      projectFamilyId(services.store.list('project'), rule.projectId) !==
        projectFamilyId(services.store.list('project'), s.projectId)
    )
      return false;
    if (rule.kind === 'content') {
      if (rule.documentId)
        return services.knowledge.accessible(services.knowledge.get(rule.documentId), sessionId);
      const ids = a.handlers.get(rule.kind).inputIds(rule);
      return (
        ids.length > 0 &&
        ids.every(
          (id) => !!id && services.knowledge.accessible(services.knowledge.get(id), sessionId),
        )
      );
    }
    return true;
  };
  const assertRule = (rule: AutomationRule, sessionId: string) => {
    if (!accessibleRule(rule, sessionId))
      throw new Error('任务引用的项目或资料不在当前会话可用范围');
  };
  const accessibleJob = (job: AutomationJob, sessionId: string) => {
    if (!accessibleRule(job.rule, sessionId)) return false;
    if (
      job.source &&
      !services.knowledge.accessible(services.knowledge.get(job.source.id), sessionId)
    )
      return false;
    if (
      job.outputId &&
      !services.knowledge.accessible(services.knowledge.get(job.outputId), sessionId)
    )
      return false;
    if (job.context?.memoryJobId) {
      const m = services.store.get<MemoryJob>('knowledgeMemoryJob', job.context.memoryJobId);
      const s = services.store.get<Session>('session', sessionId);
      return (
        m.scope === `session:${sessionId}` ||
        (!!s.projectId &&
          m.scope === `project:${projectFamilyId(services.store.list('project'), s.projectId)}`)
      );
    }
    return true;
  };
  const define = (
    name: string,
    description: string,
    args: [] | [z.ZodType, ...z.ZodType[]],
    fn: (...args: any[]) => any,
  ) =>
    register(
      name,
      ['automationState', 'automationJobRead', 'automationReview'].includes(name)
        ? workspaceOperation(
            services.store,
            '自动化与定时',
            name === 'automationReview' ? 'change' : 'query',
            description,
            args,
          )
        : operation('自动化与定时', 'change', description, args, {
            confirmation: ['automationDelete', 'contentFlowDelete'].includes(name)
              ? 'always'
              : undefined,
            guard: (values, sessionId) => {
              interactive(sessionId);
              if (name === 'automationSave') {
                const next = values[0] as AutomationRule;
                if (next.id)
                  assertRule(services.store.get<AutomationRule>('automation', next.id), sessionId);
                assertRule(next, sessionId);
              } else if (['automationRun', 'automationDelete'].includes(name)) {
                assertRule(
                  services.store.get<AutomationRule>('automation', String(values[0])),
                  sessionId,
                );
              } else if (['automationRetry', 'automationCancel'].includes(name)) {
                const job = services.store.get<AutomationJob>('automationJob', String(values[0]));
                if (!accessibleJob(job, sessionId)) throw new Error('执行记录不在当前会话可用范围');
                assertRule(
                  services.store.get<AutomationRule>('automation', job.rule.id),
                  sessionId,
                );
              } else if (
                name === 'contentReady' &&
                !services.knowledge.accessible(services.knowledge.get(String(values[0])), sessionId)
              ) {
                throw new Error('文档已归档或不在当前范围');
              }
            },
          }),
      fn,
    );
  register(
    'automationCapabilities',
    operation('自动化与定时', 'query', '发现已注册的任务模块、支持的触发方式和内置任务 ID'),
    () => a.handlers.capabilities(),
  );
  const scopeGuard = (args: unknown[], current: string) => {
    if (args[0] !== current) throw new Error('只能查询当前会话可访问的自动化');
  };
  register(
    'automationList',
    operation(
      '自动化与定时',
      'query',
      '读取当前会话范围的流程、规则与执行摘要；sessionId 必须是当前会话',
      [id],
      { guard: scopeGuard },
    ),
    (sessionId) => {
      const state = a.state();
      return {
        capabilities: state.capabilities,
        flows: state.flows,
        rules: state.rules.filter((r) => {
          try {
            return accessibleRule(r, sessionId);
          } catch {
            return false;
          }
        }),
        jobs: services.store
          .list<AutomationJob>('automationJob')
          .filter((j) => {
            try {
              return accessibleJob(j, sessionId);
            } catch {
              return false;
            }
          })
          .slice(-200)
          .reverse()
          .map((j) => ({
            id: j.id,
            name: j.rule.name,
            status: j.status,
            createdAt: j.createdAt,
            attempt: j.attempt,
          })),
      };
    },
  );
  register(
    'automationResult',
    operation(
      '自动化与定时',
      'query',
      '读取当前会话可访问的一次执行结果；不返回输入正文，记忆原文使用 knowledge_read',
      [id, id],
      {
        guard: (args, sessionId) => {
          scopeGuard(args, sessionId);
          if (
            !accessibleJob(
              services.store.get<AutomationJob>('automationJob', String(args[1])),
              sessionId,
            )
          )
            throw new Error('执行记录不在当前会话可用范围');
        },
      },
    ),
    (_sessionId, jobId) => a.readJob(jobId),
  );
  define('automationJobRead', '读取执行结果', [id], (v) => a.readJob(id.parse(v)));
  define('automationState', '读取处理流程、自动化与任务结果', [], () => a.state());
  define('contentFlowSave', '保存通用内容处理流程', [flowSchema], (raw) => a.saveFlow(raw));
  define('contentFlowDelete', '删除未使用的处理流程', [id], (v) => a.deleteFlow(id.parse(v)));
  define('automationSave', '保存自动化与定时任务', [automationSchema], (raw) => a.save(raw));
  define('automationDelete', '删除自动化配置', [id], (v) => a.delete(id.parse(v)));
  define('automationRun', '立即执行一次自动化', [id], (v) => a.run(id.parse(v)));
  define('automationCancel', '取消一次执行', [id], (v) => a.cancel(id.parse(v)));
  define('automationRetry', '重试失败的执行', [id], (v) => a.retry(id.parse(v)));
  define('automationReview', '将执行结果标为已查看', [id], (v) => a.review(id.parse(v)));
  define(
    'contentReady',
    '标记当前版本就绪并触发内容自动化',
    [id, z.number().int().positive()],
    (v, version) => {
      const doc = services.knowledge.get(id.parse(v));
      if (doc.version !== version) throw new Error('文档已更新，请保存后重新标记');
      a.event('ready', doc.id);
    },
  );
}
