import { useState } from 'react';
import { ChevronDown, ShieldAlert } from 'lucide-react';
import type { Approval } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';
import './approval.css';

function approvalDescription(approval: Approval) {
  let title = approval.title;
  try {
    const detail = JSON.parse(approval.detail);
    if (title === 'Codex 请求执行许可')
      title =
        detail.kind === 'command' || detail.command
          ? '运行命令'
          : detail.kind === 'fileChange' || detail.grantRoot || detail.changes
            ? '修改文件'
            : '执行操作';
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
        <span className="approval-scope">仅本次</span>
        <div className="approval-actions">
          <button
            className="approval-detail-toggle"
            aria-label={detailsOpen ? '收起操作详情' : '查看操作详情'}
            aria-expanded={detailsOpen}
            aria-controls={`approval-detail-${approval.id}`}
            title={detailsOpen ? '收起操作详情' : '查看操作详情'}
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            <ChevronDown size={14} className={detailsOpen ? 'rotate' : ''} />
          </button>
          <button className="secondary" disabled={busy} onClick={() => void decide(false)}>
            拒绝
          </button>
          <button className="approval-confirm" disabled={busy} onClick={() => void decide(true)}>
            {busy ? '处理中…' : '批准本次'}
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
}: {
  approvals: Approval[];
  onDecide(id: string, allow: boolean): Promise<void>;
}) {
  if (!approvals.length) return null;
  return (
    <div className="approval-queue" aria-label="待批准操作">
      <p className="approval-count" role="status">
        {approvals.length} 项操作等待你批准
      </p>
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onDecide={onDecide} />
      ))}
    </div>
  );
}
