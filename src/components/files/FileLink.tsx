import type { ReactNode } from 'react';
import { FileText } from 'lucide-react';
import './file-link.css';

export function FileLink({
  name,
  label,
  title,
  className = '',
  icon,
  children,
  onOpen,
}: {
  name: string;
  label: string;
  title?: string;
  className?: string;
  icon?: ReactNode;
  children?: ReactNode;
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      className={`file-link ${className}`}
      aria-label={label}
      title={title ?? name}
      onClick={onOpen}
    >
      {icon ?? <FileText size={15} />}
      <span className="file-link-name">{name}</span>
      {children}
    </button>
  );
}
