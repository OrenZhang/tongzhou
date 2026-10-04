import type { ReactNode } from 'react';

const TONES: Record<string, string> = {
  gray: 'badge-gray',
  green: 'badge-green',
  red: 'badge-red',
  blue: 'badge-blue',
  orange: 'badge-orange',
};

export function Badge({ text, tone = 'gray' }: { text: string; tone?: string }) {
  return <span className={`badge ${TONES[tone] ?? 'badge-gray'}`}>{text}</span>;
}

export function Empty({ text = '暂无数据' }: { text?: string }) {
  return <div className="empty">{text}</div>;
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= 0) return null;
  return (
    <div className="pagination">
      <button className="btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        上一页
      </button>
      <span className="muted">
        第 {page} / {pages} 页 · 共 {total} 条
      </span>
      <button className="btn" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        下一页
      </button>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' modal-wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function FormError({ message }: { message: string }) {
  if (!message) return null;
  return <div className="alert">{message}</div>;
}
