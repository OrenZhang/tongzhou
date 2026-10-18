import { t as tr } from '../../shared/i18n';
import { useState } from 'react';
import { ChevronDown, ShieldAlert } from 'lucide-react';
import type { Approval } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';
import './approval.css';
import { QuestionCard } from './QuestionCard';
import type { QuestionAnswers } from '../../shared/agent-execution';

function approvalDescription(approval: Approval) {
  let title = approval.title;
  try {
    const detail = JSON.parse(approval.detail);
    if (title === 'Codex 请求执行许可')
      title =
        detail.kind === 'command' || detail.command
          ? tr('运行命令')
          : detail.kind === 'fileChange' || detail.grantRoot || detail.changes
            ? tr('修改文件')
            : tr('执行操作');
    const reason = detail.reason ?? detail.requestReason;
    if (typeof reason === 'string' && reason.trim()) title += `：${reason}`;
  } catch {
    // Tool titles already describe the action; raw arguments stay in the optional details.
  }
  return title.replace(/\s+/g, ' ').trim();
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide(id: string, allow: boolean): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const description = approvalDescription(approval);
  const decide = async (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onDecide(approval.id, allow);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <section className="approval-card" role="region" aria-label={approval.title} aria-busy={busy}>
      <div className="approval-row">
        <ShieldAlert size={14} />
        <span className="approval-description" title={description}>
          {description}
        </span>
        <span className="approval-scope">{tr('仅本次')}</span>
        <div className="approval-actions">
          <button
            className="approval-detail-toggle"
            aria-label={detailsOpen ? tr('收起操作详情') : tr('查看操作详情')}
            aria-expanded={detailsOpen}
            aria-controls={`approval-detail-${approval.id}`}
            title={detailsOpen ? tr('收起操作详情') : tr('查看操作详情')}
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            <ChevronDown size={14} className={detailsOpen ? 'rotate' : ''} />
          </button>
          <button className="secondary" disabled={busy} onClick={() => void decide(false)}>
            {tr('拒绝')}
          </button>
          <button className="approval-confirm" disabled={busy} onClick={() => void decide(true)}>
            {busy ? tr('处理中…') : tr('批准本次')}
          </button>
        </div>
      </div>
      <div className="approval-details" id={`approval-detail-${approval.id}`} hidden={!detailsOpen}>
        <pre>{approval.detail}</pre>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function ApprovalQueue({
  approvals,
  onDecide,
  onAnswer,
}: {
  approvals: Approval[];
  onDecide(id: string, allow: boolean): Promise<void>;
  onAnswer(id: string, answers: QuestionAnswers | null): Promise<void>;
}) {
  if (!approvals.length) return null;
  return (
    <div className="approval-queue" aria-label={tr('待批准操作')}>
      <p className="approval-count" role="status">
        {approvals.length}
        {tr(' 项等待你处理')}
      </p>
      {approvals.map((approval) =>
        approval.kind === 'question' ? (
          <QuestionCard key={approval.id} request={approval} onAnswer={onAnswer} />
        ) : (
          <ApprovalCard key={approval.id} approval={approval} onDecide={onDecide} />
        ),
      )}
    </div>
  );
}
