import { taskToolPreparation } from './task-tools';
import type { ExecutionNetwork } from '../core/task-contracts';
import type { Store } from '../services/storage/store';
import { Terminals } from '../services/desktop/terminals';
import type { DomainServices } from '../modules/domain-services';
import { SessionLifecycle } from '../modules/sessions/session-lifecycle';
import { Automations } from '../modules/automation/automations';
import { ApprovalQueue } from '../core/runtime/approval-queue';
import { TaskScheduler } from '../core/runtime/task-scheduler';
import { CodexExecution } from '../core/codex/execution';
import type { ApplicationEvents, EngineInvalidation } from '../core/application-events';
import type { ClientCommands } from '../core/tools/client-commands';
import type { ComputerAdapter } from '../core/tools/extensions';

/** Composition owns resources; the scheduler only receives the capabilities it uses. */
export async function createTaskSystem(
  store: Store,
  dataDir: string,
  events: ApplicationEvents,
  domains: DomainServices,
  network: ExecutionNetwork,
  computer?: ComputerAdapter,
  commands?: ClientCommands,
  projectUnavailable?: (id: string) => boolean,
) {
  let tasks: TaskScheduler | undefined;
  let execution: CodexExecution | undefined;
  let automations: Automations | undefined;
  const terminals = new Terminals(store, events.changed, dataDir);
  const sessions = new SessionLifecycle(store, dataDir, {
    isActive: (id) => tasks!.isActive(id),
    removeEngineSession: (id) => execution!.removeSession(id),
    stopTerminalSession: (id) => terminals.stopSession(id),
    changed: events.changed,
  });
  const approvals = new ApprovalQueue(store, events.publish, events.changed, (run, id) =>
    events.emit('lifecycle', run, 'approval', id),
  );
  const cleanupErrors: unknown[] = [];
  let producersStopped = false;
  const stopProducers = () => {
    if (producersStopped) return;
    producersStopped = true;
    for (const stop of [
      () => automations?.stop(),
      () => approvals.dispose(),
      () => terminals.dispose(),
    ]) {
      try {
        stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  };
  const invalidations = new Set<Promise<void>>();
  const invalidate = ({ providerId, protocol }: EngineInvalidation) => {
    const ids = protocol
      ? store
          .providers()
          .filter((p) => p.protocol === protocol)
          .map((p) => p.id)
      : [providerId];
    for (const id of ids) {
      const pending = execution!
        .invalidate(id)
        .catch((error) => {
          cleanupErrors.push(error);
        })
        .finally(() => invalidations.delete(pending));
      invalidations.add(pending);
    }
  };
  const detach = () => {
    events.off('shutdown', stopProducers);
    events.off('engineInvalidated', invalidate);
  };
  let closing: Promise<void> | undefined;
  const dispose = () =>
    (closing ??= (async () => {
      stopProducers();
      detach();
      try {
        tasks?.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      const settled = await Promise.allSettled([
        tasks ? tasks.waitForIdle() : execution?.close(),
        ...invalidations,
      ]);
      for (const result of settled)
        if (result.status === 'rejected') cleanupErrors.push(result.reason);
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '部分任务资源未能正常释放');
    })());
  try {
    tasks = new TaskScheduler(store, dataDir, events.publish, {
      ...domains,
      events,
      sessions,
      approvals,
      prepareTools: taskToolPreparation(
        store,
        domains,
        terminals,
        events.changed,
        computer,
        commands,
        (input) => tasks!.start(input),
      ),
      projectUnavailable,
      createExecution: (callbacks) =>
        (execution = new CodexExecution({
          ...callbacks,
          store,
          dataDir,
          attachments: domains.attachments,
          sessions,
          resolveNetwork: (profile, runId) => network.resolve(profile, runId),
          modelTransport: (profile) =>
            network.transport ? network.transport(profile) : Promise.resolve(fetch),
        })),
    });
    automations = new Automations(store, {
      content: domains.content,
      knowledge: domains.knowledge,
      start: (...args) => tasks!.start(...args),
      cancel: (id) => tasks!.cancel(id),
      changed: events.changed,
    });
    events.once('shutdown', stopProducers);
    events.on('engineInvalidated', invalidate);
    automations.start();
    return { tasks, execution: execution!, sessions, approvals, terminals, automations, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '任务服务启动失败，清理资源时发生错误');
    }
    throw error;
  }
}
