import type { AutomationJob, AutomationRule } from '../../../src/shared/automation';
import type { Run, Session } from '../../../src/shared/types';
import type { Store } from '../storage/store';

/** A saved output destination authorizes delivery of this job's final answer only. */
export function automationNotification(store: Store, session: Session, run: Run) {
  if (!session.automationJob) return;
  const job = store
    .list<AutomationJob>('automationJob')
    .find((j) => j.id === session.automationJob);
  const current = store.list<AutomationRule>('automation').find((r) => r.id === job?.rule.id);
  const target = job?.rule.notificationTargetId;
  if (
    !job ||
    !target ||
    current?.notificationTargetId !== target ||
    (!current.enabled && !job.manual) ||
    job.rule.kind !== 'task' ||
    job.sessionId !== session.id ||
    (job.runId && job.runId !== run.id)
  )
    return;
  const result = store
    .messages(session.id)
    .filter((m) => m.runId === run.id && m.role === 'assistant' && m.status === 'complete')
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n\n');
  if (!result) return;
  return {
    target,
    key: 'automation:' + job.id,
    text: result.length > 4000 ? result.slice(0, 3900) + '\n…完整结果请在同舟查看。' : result,
  };
}
