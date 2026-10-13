import { useState } from 'react';
import type { ChildAgent } from '../../shared/agent-execution';
import { errorMessage } from '../../lib/feedback';

const labels: Record<ChildAgent['status'], string> = {
  pending: '准备中',
  running: '运行中',
  waiting: '等待输入',
  completed: '已完成',
  interrupted: '已中断',
  failed: '失败',
  closed: '已关闭',
};
export function AgentActivity({
  agents,
  active,
  onControl,
}: {
  agents: ChildAgent[];
  active: boolean;
  onControl?: (id: string, action: 'interrupt' | 'resume') => Promise<void>;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const control = async (id: string, action: 'interrupt' | 'resume') => {
    setBusy(id);
    setError('');
    try {
      await onControl?.(id, action);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  };
  if (!agents.length) return null;
  return (
    <section className="agent-activity" aria-label="子 Agent 任务">
      <small className="muted">
        子任务 · {agents.filter((a) => a.status === 'completed').length}/{agents.length} 已完成
      </small>
      {agents.map((agent) => (
        <details key={agent.threadId}>
          <summary>
            <span className="agent-activity-name">{agent.name}</span>
            <small>
              {agent.pendingAction === 'resume'
                ? '等待恢复'
                : (agent.phase ?? labels[agent.status])}
            </small>
            {active &&
              onControl &&
              ['running', 'waiting', 'interrupted', 'failed'].includes(agent.status) && (
                <button
                  disabled={!!busy || !!agent.pendingAction}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void control(
                      agent.threadId,
                      ['running', 'waiting'].includes(agent.status) ? 'interrupt' : 'resume',
                    );
                  }}
                >
                  {busy === agent.threadId
                    ? '处理中…'
                    : ['running', 'waiting'].includes(agent.status)
                      ? '停止'
                      : '继续'}
                </button>
              )}
          </summary>
          {agent.model && (
            <small className="muted">
              {agent.model}
              {agent.reasoningEffort ? ` · ${agent.reasoningEffort}` : ''}
            </small>
          )}
          {agent.usageReported && (
            <small className="muted">
              {' '}
              · Tokens {(agent.inputTokens ?? 0) + (agent.outputTokens ?? 0)}
            </small>
          )}
          {agent.startedAt && agent.endedAt && (
            <small className="muted">
              {' '}
              · {Math.max(0, Math.floor((agent.endedAt - agent.startedAt) / 1000))}秒
            </small>
          )}
          {agent.message && <p>{agent.message}</p>}
        </details>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
