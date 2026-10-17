import {
  useEffect,
  useState,
  type DragEvent,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { TongzhouAPI } from '../../shared/types';

export function useComposerDrop({
  api,
  input,
  setDraft,
  addFiles,
  disabled,
  sessionId,
  report,
}: {
  api: TongzhouAPI;
  input: RefObject<HTMLTextAreaElement | null>;
  setDraft: Dispatch<SetStateAction<string>>;
  addFiles(files: File[]): Promise<unknown>;
  disabled: boolean;
  sessionId: string;
  report(error: unknown): void;
}) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => setDragging(false), [sessionId, disabled]);
  const isFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  return {
    dragging,
    handlers: {
      onDragOver(e: DragEvent<HTMLDivElement>) {
        if (!isFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
        setDragging(!disabled);
      },
      onDragLeave(e: DragEvent<HTMLDivElement>) {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget))
          setDragging(false);
      },
      onDrop(e: DragEvent<HTMLDivElement>) {
        if (!isFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        if (disabled) return;
        const paths: string[] = [],
          virtual: File[] = [];
        try {
          for (const file of Array.from(e.dataTransfer.files)) {
            const path = api.droppedFilePath(file);
            if (path) paths.push(path);
            else virtual.push(file);
          }
          if (paths.length) {
            const textarea = input.current;
            const start = textarea?.selectionStart;
            const end = textarea?.selectionEnd;
            const text = [...new Set(paths)].join('\n');
            setDraft((old) => {
              const before = old.slice(0, start ?? old.length),
                after = old.slice(end ?? old.length);
              return (
                before +
                (before && !/\s$/.test(before) ? '\n' : '') +
                text +
                (after && !/^\s/.test(after) ? '\n' : '') +
                after
              );
            });
            textarea?.focus();
          }
          // Browser-generated files have no disk path; retain the existing attachment flow.
          if (virtual.length) void addFiles(virtual).catch(report);
        } catch (error) {
          report(error);
        }
      },
    },
  };
}
