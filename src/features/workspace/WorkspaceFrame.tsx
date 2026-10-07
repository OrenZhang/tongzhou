import { useRef, type ReactNode } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';

export function WorkspaceFrame({
  children,
  header,
  width,
  expanded,
  onResize,
  onExpand,
  onClose,
  label = '会话工作区',
  className = '',
}: {
  children: ReactNode;
  header: ReactNode;
  width: number;
  expanded: boolean;
  onResize(width: number): void;
  onExpand(): void;
  onClose(): void;
  label?: string;
  className?: string;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number) => onResize(Math.max(320, Math.min(900, value)));
  return (
    <aside
      className={`task-workspace ${expanded ? 'expanded' : ''} ${className}`}
      style={{ width }}
      aria-label={label}
    >
      <div
        className="workspace-resizer"
        role="separator"
        aria-label="调整工作区宽度"
        aria-orientation="vertical"
        tabIndex={0}
        aria-valuemin={320}
        aria-valuemax={900}
        aria-valuenow={width}
        onKeyDown={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            resize(
              e.key === 'Home'
                ? 320
                : e.key === 'End'
                  ? 900
                  : width + (e.key === 'ArrowLeft' ? 24 : -24),
            );
          }
        }}
        onPointerDown={(e) => {
          drag.current = {
            x: e.clientX,
            width: e.currentTarget.parentElement!.getBoundingClientRect().width,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) resize(drag.current.width + drag.current.x - e.clientX);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
      <header className="workspace-heading">
        {header}
        <button
          className="icon-button"
          aria-label={expanded ? '还原工作区宽度' : '放大工作区'}
          onClick={onExpand}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button className="icon-button" aria-label="关闭工作区" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {children}
    </aside>
  );
}
