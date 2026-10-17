import type { Store } from '../../services/storage/store';
import type { AutomationHandler } from '../automation/automation-handlers';
import type { AutomationRule } from '../../../src/shared/automation';
import type { Session } from '../../../src/shared/types';
import { isUserSession } from '../../../src/shared/session-scope';
import { effectivePermission } from '../../../src/shared/permissions';
import { agentProfile } from '../agents/agents';
import { executionOrder } from './canvas';
import type { CanvasWorkflows } from './workflow';

export function canvasAutomationHandler(
  store: Store,
  workflows: CanvasWorkflows,
): AutomationHandler {
  const resolve = (rule: AutomationRule) => {
    if (!rule.canvas || rule.permission !== 'ask')
      throw new Error('画布定时任务需要绑定画布，并使用需确认权限');
    const ref = rule.canvas,
      canvas = workflows.canvases.get(ref.id);
    if (canvas.version !== ref.version) throw new Error('画布已修改，请在定时触发节点重新发布');
    const owner = store.get<Session>('session', ref.sessionId);
    if (
      !isUserSession(owner) ||
      owner.archived ||
      (owner.projectId ?? undefined) !== rule.projectId
    )
      throw new Error('画布执行会话不可用或项目已变化，请重新发布');
    if (
      effectivePermission(
        owner,
        store.defaultPermission(),
        owner.agentId ? agentProfile(store, owner.agentId) : undefined,
      ) === 'read-only'
    )
      throw new Error('画布执行会话为只读，请调整权限后重新发布');
    const trigger = canvas.nodes.find(
      (n) => n.id === ref.nodeId && n.pluginId === 'workflow.schedule',
    );
    if (!trigger) throw new Error('定时触发节点已删除');
    workflows.canvases.plugins.validate(trigger);
    const selected = new Set([trigger.id]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of canvas.edges)
        if (edge.kind === 'dependency' && selected.has(edge.from) && !selected.has(edge.to)) {
          selected.add(edge.to);
          changed = true;
        }
    }
    if (selected.size < 2) throw new Error('请把定时触发节点连接到需要执行的节点');
    const nodeIds = executionOrder(canvas, [...selected]);
    if (nodeIds.length > 50) throw new Error('定时工作流最多执行 50 个节点');
    for (const id of nodeIds)
      workflows.canvases.plugins.validate(canvas.nodes.find((n) => n.id === id)!);
    return { canvas, owner, nodeIds };
  };
  return {
    kind: 'canvas',
    capability: {
      kind: 'canvas',
      name: '画布工作流',
      description: '按发布版本执行定时触发节点连接的工作流',
      triggers: ['schedule', 'manual'],
    },
    validate: (rule) => {
      resolve(rule);
    },
    inputIds: () => [undefined],
    capture: () => ({}),
    prepare: () => undefined,
    complete: () => undefined,
    execution: {
      start(job) {
        const { canvas, owner, nodeIds } = resolve(job.rule);
        const session = store.createSession(owner.projectId);
        store.put('session', {
          ...session,
          providerId: job.rule.providerId ?? owner.providerId,
          model: job.rule.model ?? owner.model,
          agentId: job.rule.agentId ?? owner.agentId,
          permission: 'ask',
          automationJob: job.id,
          title: '定时画布 · ' + canvas.title,
        });
        const run = workflows.startScheduled(
          {
            canvasId: canvas.id,
            version: canvas.version,
            sessionId: session.id,
            nodeIds,
            reuse: false,
          },
          job.id,
        );
        return { runId: run.id, sessionId: session.id };
      },
      read(job) {
        if (!job.runId) return { status: 'failed', error: '工作流启动中断，请检查执行记录' };
        const run = workflows.canvases.runs.get(job.runId);
        if (run.status === 'running') return { status: 'running' };
        if (run.status !== 'completed')
          return { status: 'failed', error: run.error ?? '工作流已停止' };
        return {
          status: 'completed',
          result: Object.entries(run.nodes)
            .map(
              ([id, step]) =>
                `${run.definition.nodes.find((n) => n.id === id)?.title ?? id}：${step.output?.text ?? step.status}`,
            )
            .join('\n\n')
            .slice(0, 32000),
        };
      },
      async cancel(job) {
        if (job.runId) await workflows.cancel(job.runId);
      },
    },
  };
}
