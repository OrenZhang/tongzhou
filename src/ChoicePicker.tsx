import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface Choice {
  value: string;
  label: string;
  detail?: string;
}

export function ChoicePicker({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
  searchable = false,
  placeholder = '请选择',
}: {
  id?: string;
  label: string;
  value: string;
  options: Choice[];
  onChange(value: string): void;
  disabled?: boolean;
  compact?: boolean;
  searchable?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 360 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const filtered = options.filter((o) =>
    `${o.label} ${o.detail ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const below = innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const down = below >= Math.min(360, panel.current?.scrollHeight ?? 360) || below >= above;
      const maxHeight = Math.min(360, Math.max(100, down ? below : above));
      const height = Math.min(panel.current?.scrollHeight ?? maxHeight, maxHeight);
      setPosition({
        left: Math.max(12, Math.min(rect.left, innerWidth - 332)),
        top: down ? rect.bottom + 8 : Math.max(8, rect.top - height - 8),
        maxHeight,
      });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, query, options.length]);
  useEffect(() => {
    if (!open) return;
    (
      panel.current?.querySelector<HTMLInputElement>('input') ??
      panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      panel.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
    )?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <>
      <button
        id={id}
        ref={trigger}
        type="button"
        className={`choice-trigger ${compact ? 'compact' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-value={value}
        value={value}
        disabled={disabled || !options.length}
        onClick={() => {
          setQuery('');
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{options.find((o) => o.value === value)?.label ?? placeholder}</span>
        <ChevronDown size={14} />
      </button>
      {open &&
        createPortal(
          <div
            id={menuId}
            ref={panel}
            className="choice-panel"
            role="dialog"
            aria-label={`${label}选择`}
            style={position}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) close();
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close(true);
              }
              const items = [
                ...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ??
                  []),
              ];
              if (
                ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) &&
                !(e.target instanceof HTMLInputElement && ['Home', 'End'].includes(e.key))
              ) {
                e.preventDefault();
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : index < 0
                        ? e.key === 'ArrowUp'
                          ? items.length - 1
                          : 0
                        : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
              }
              if (e.key === 'Enter' && e.target instanceof HTMLInputElement && filtered.length) {
                e.preventDefault();
                onChange(filtered[0].value);
                close(true);
              }
            }}
          >
            <div className="choice-heading">
              {label}
              <small>{options.length} 个选项</small>
            </div>
            {searchable && (
              <label className="choice-search">
                <Search size={14} />
                <input
                  aria-label={`搜索${label}`}
                  placeholder="搜索名称…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            )}
            <div className="choice-list" role="menu" aria-label={label}>
              {filtered.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  role="menuitemradio"
                  aria-label={o.label}
                  aria-checked={o.value === value}
                  data-value={o.value}
                  onClick={() => {
                    onChange(o.value);
                    close(true);
                  }}
                >
                  <span>
                    <strong>{o.label}</strong>
                    {o.detail && <small>{o.detail}</small>}
                  </span>
                  {o.value === value && <Check size={15} />}
                </button>
              ))}
              {!filtered.length && <p className="choice-empty">没有匹配的选项</p>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
