import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ListPlus, MessageSquarePlus, RotateCcw } from 'lucide-react';
import type { PendingInput } from './shared/types';

export const inputModes = [
  {
    value: 'supplement',
    label: '补充当前任务',
    detail: '在下一安全点加入本轮处理',
    icon: MessageSquarePlus,
  },
  { value: 'next', label: '排队下一轮', detail: '本轮结束后再发送', icon: ListPlus },
  {
    value: 'restart',
    label: '停止后继续',
    detail: '停止本轮，再用补充内容开启下一轮',
    icon: RotateCcw,
  },
] as const;

export function InputModePicker({
  value,
  onChange,
}: {
  value: PendingInput['mode'];
  onChange: (value: PendingInput['mode']) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ bottom: 0, right: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = inputModes.find((mode) => mode.value === value)!;
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          bottom: innerHeight - rect.top + 8,
          right: Math.max(8, innerWidth - rect.right),
        });
    };
    reposition();
    panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (e: MouseEvent) => {
      if (
        !panel.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        className="icon-button input-mode-trigger"
        aria-label="补充方式"
        title={`补充方式：${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <selected.icon size={17} />
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={panel}
            className="input-mode-menu"
            style={position}
            role="menu"
            aria-label="补充方式"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
                trigger.current?.focus();
              }
              const options = [
                ...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ??
                  []),
              ];
              const index = options.indexOf(document.activeElement as HTMLButtonElement);
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? options.length - 1
                      : (index + (e.key === 'ArrowDown' ? 1 : -1) + options.length) %
                        options.length;
                options[next]?.focus();
              }
            }}
          >
            {inputModes.map((mode) => (
              <button
                key={mode.value}
                role="menuitemradio"
                aria-checked={mode.value === value}
                aria-label={mode.label}
                onClick={() => {
                  onChange(mode.value);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <mode.icon size={16} />
                <span>
                  <strong>{mode.label}</strong>
                  <small>{mode.detail}</small>
                </span>
                {mode.value === value && <Check size={14} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
