import { useEffect, useState } from 'react';
import type { TongzhouAPI } from './shared/types';
import type { TaskState } from './shared/task';

export type WorkspaceTab = 'files' | 'review' | 'terminal';
export interface WorkspaceLayout {
  open: boolean;
  tab: WorkspaceTab;
  width: number;
  expanded: boolean;
  dock: 'right' | 'bottom';
  terminalOpen: boolean;
  terminalId: string;
  runId: string;
  reviewTab: 'changes' | 'evidence';
  scope: 'task' | 'directory';
}
const initial: WorkspaceLayout = {
  open: false,
  tab: 'files',
  width: 430,
  expanded: false,
  dock: 'right',
  terminalOpen: false,
  terminalId: '',
  runId: '',
  reviewTab: 'changes',
  scope: 'task',
};
function readLayout(id: string): WorkspaceLayout {
  try {
    const value = JSON.parse(localStorage.getItem(`tongzhou-workspace-${id}`) ?? '{}');
    return {
      ...initial,
      open: value.open === true,
      expanded: value.expanded === true,
      tab: ['files', 'review', 'terminal'].includes(value.tab) ? value.tab : 'files',
      width: Number.isFinite(value.width) ? Math.max(320, Math.min(900, value.width)) : 430,
      dock: value.dock === 'bottom' ? 'bottom' : 'right',
      terminalOpen: value.terminalOpen === true,
      terminalId: typeof value.terminalId === 'string' ? value.terminalId : '',
      runId: typeof value.runId === 'string' ? value.runId : '',
      reviewTab: value.reviewTab === 'evidence' ? 'evidence' : 'changes',
      scope: value.scope === 'directory' ? 'directory' : 'task',
    };
  } catch {
    return { ...initial };
  }
}
export function useWorkspaceLayout(sessionId: string) {
  const [layouts, setLayouts] = useState<Record<string, WorkspaceLayout>>({});
  const layout = layouts[sessionId] ?? readLayout(sessionId);
  const update = (patch: Partial<WorkspaceLayout>) => {
    if (!sessionId) return;
    setLayouts((old) => {
      const next = { ...(old[sessionId] ?? readLayout(sessionId)), ...patch };
      localStorage.setItem(`tongzhou-workspace-${sessionId}`, JSON.stringify(next));
      return { ...old, [sessionId]: next };
    });
  };
  return [layout, update] as const;
}

// Key results by session so late reads cannot show another conversation's directory or changes.
export function useTaskContext(
  api: TongzhouAPI,
  sessionId: string,
  projectId: string | undefined,
  revision: string,
  active: boolean,
) {
  const [result, setResult] = useState<{
    id: string;
    task?: TaskState;
    branch?: string;
    error?: string;
  }>({ id: '' });
  useEffect(() => {
    if (!api || !sessionId || !active) return;
    let alive = true,
      loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      const [task, git] = await Promise.allSettled([
        api.taskState(sessionId),
        projectId ? api.projectChanges(projectId, 'unstaged') : Promise.resolve(undefined),
      ]);
      if (alive)
        setResult({
          id: sessionId,
          task: task.status === 'fulfilled' ? task.value : undefined,
          branch:
            git.status === 'fulfilled'
              ? git.value
                ? git.value.repository
                  ? git.value.branch || '未命名分支'
                  : '未使用 Git'
                : undefined
              : '分支读取失败',
          error: task.status === 'rejected' ? '执行上下文读取失败' : undefined,
        });
      loading = false;
    };
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [api, sessionId, projectId, revision, active]);
  return result.id === sessionId ? result : { id: sessionId };
}
