import { useState } from 'react';
import { Plus, X } from 'lucide-react';
export function MultiValueInput({
  value,
  onChange,
  label,
  placeholder = '输入后按 Enter 添加',
  split = true,
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  label: string;
  placeholder?: string;
  split?: boolean;
  id?: string;
}) {
  const [pending, setPending] = useState('');
  const add = (text = pending) => {
    const items = (split ? text.split(/[,，;；\n]+/) : text.split(/\r?\n/))
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length) onChange(split ? [...new Set([...value, ...items])] : [...value, ...items]);
    setPending('');
  };
  return (
    <div className="multi-value">
      <div className="multi-value-tags">
        {value.map((item, i) => (
          <span key={i} className="input-chip">
            <span>{item}</span>
            <button
              type="button"
              aria-label={`移除 ${item}`}
              onClick={() => onChange(value.filter((_, n) => n !== i))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="multi-value-add">
        <input
          id={id}
          aria-label={label}
          placeholder={placeholder}
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onBlur={() => add()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/\n/.test(text) || (split && /[,，;；]/.test(text))) {
              e.preventDefault();
              add(pending + text);
            }
          }}
        />
        <button
          type="button"
          aria-label={`添加${label}`}
          disabled={!pending.trim()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => add()}
        >
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}
