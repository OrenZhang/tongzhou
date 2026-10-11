import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
import './plugins.css';

export function PluginTile({
  name,
  type,
  icon,
  enabled,
  disabled,
  onToggle,
  onOpen,
}: {
  name: string;
  type: string;
  icon: ReactNode;
  enabled: boolean;
  disabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  onOpen(): void;
}) {
  return (
    <article className="plugin-tile">
      <button
        type="button"
        className="plugin-tile-open"
        onClick={onOpen}
        aria-label={`查看 ${name}`}
      >
        <span className="plugin-tile-icon">{icon}</span>
        <span className="plugin-tile-label">
          <h3>{name}</h3>
          <small>{type}</small>
        </span>
      </button>
      <label
        className="switch-control"
        title={onToggle ? `启用 ${name}` : '内置应用始终可用，具体服务在详情中管理'}
      >
        <input
          type="checkbox"
          aria-label={`启用 ${name}`}
          checked={enabled}
          disabled={disabled || !onToggle}
          onChange={(e) => onToggle?.(e.target.checked)}
        />
        <span aria-hidden="true" />
      </label>
    </article>
  );
}

export function PluginDetailPage({
  title,
  subtitle,
  type = 'MCP',
  onClose,
  busy,
  children,
}: {
  title: string;
  subtitle?: string;
  type?: string;
  onClose(): void;
  busy?: boolean;
  children: ReactNode;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
  }, []);
  const outlet = document.getElementById('plugin-detail-outlet');
  if (!outlet) return null;
  return createPortal(
    <section className="plugin-detail-page" aria-label={`${title} 详情`}>
      <button
        ref={back}
        type="button"
        className="text-button plugin-detail-back"
        disabled={busy}
        onClick={onClose}
      >
        <ArrowLeft size={16} />
        返回插件列表
      </button>
      <header className="plugin-detail-heading">
        <span className="tag">{type}</span>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </header>
      <div className="plugin-detail-body">{children}</div>
    </section>,
    outlet,
  );
}

export function PluginDetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="plugin-detail-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
