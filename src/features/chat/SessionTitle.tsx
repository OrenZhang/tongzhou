import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../lib/feedback';

export function SessionTitle({
  title,
  onSave,
}: {
  title: string;
  onSave(title: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const ending = useRef(false);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const finish = (focus: boolean) => {
    setEditing(false);
    if (focus) requestAnimationFrame(() => trigger.current?.focus());
  };
  const save = async (focus = false) => {
    if (ending.current) return;
    ending.current = true;
    const value = draft.trim();
    if (!value || value === title) {
      finish(focus);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(value);
      if (alive.current) finish(focus);
    } catch (reason) {
      if (alive.current) {
        ending.current = false;
        setError(errorMessage(reason));
        requestAnimationFrame(() => input.current?.focus());
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  return editing ? (
    <div className="conversation-title-editor">
      <input
        ref={input}
        autoFocus
        aria-label="会话名称"
        title="Enter 保存 · Esc 取消"
        maxLength={120}
        value={draft}
        disabled={saving}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            void save(true);
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            ending.current = true;
            finish(true);
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </div>
  ) : (
    <h2>
      <button
        ref={trigger}
        className="conversation-title"
        title="点击标题重命名"
        onClick={() => {
          ending.current = false;
          setDraft(title);
          setError('');
          setEditing(true);
        }}
      >
        {title}
      </button>
    </h2>
  );
}
