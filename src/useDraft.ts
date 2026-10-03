import { useState } from 'react';
const key = 'tongzhou-drafts';
function load(): Record<string, string> {
  try {
    const data = JSON.parse(localStorage.getItem(key) || '{}');
    return Object.fromEntries(
      Object.entries(data).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}
export function useDraft(sessionId: string) {
  const [drafts, setDrafts] = useState(load);
  const id = sessionId || '_new';
  const change = (
    target: string,
    update: string | ((previous: string) => string),
    expected?: string,
  ) =>
    setDrafts((old) => {
      if (expected !== undefined && old[target] !== expected) return old;
      const value = typeof update === 'function' ? update(old[target] || '') : update;
      const next = { ...old };
      if (value) next[target] = value;
      else delete next[target];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Keep the in-memory draft if storage is full. */
      }
      return next;
    });
  return {
    draft: drafts[id] || '',
    setDraft: (value: string | ((previous: string) => string)) => change(id, value),
    clearDraft: (target: string, expected?: string) => change(target || '_new', '', expected),
  };
}
