import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { Approval } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';
import './approval.css';

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide(id: string, allow: boolean): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      <header>
        <ShieldAlert size={16} />
        <strong>{approval.title}</strong>
        <span>等待批准</span>
      </header>
      <pre>{approval.detail}</pre>
      {error && <p role="alert">{error}</p>}
      <footer>
        <small>批准后才会执行，仅限本次操作。</small>
        <button className="secondary" disabled={busy} onClick={() => void decide(false)}>
          拒绝
        </button>
        <button className="approval-confirm" disabled={busy} onClick={() => void decide(true)}>
          {busy ? '处理中…' : '批准本次'}
        </button>
      </footer>
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
