import type { Project, Session } from './types';

/** Include archived workspaces and internal child sessions in project deletion. */
export function projectDeletionTargets(projects: Project[], sessions: Session[], id: string) {
  const projectIds = new Set([id]);
  const sessionIds = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of projects)
      if (p.sourceProjectId && projectIds.has(p.sourceProjectId) && !projectIds.has(p.id)) {
        projectIds.add(p.id);
        changed = true;
      }
  }
  for (const s of sessions) if (s.projectId && projectIds.has(s.projectId)) sessionIds.add(s.id);
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of sessions)
      if (s.parentId && sessionIds.has(s.parentId) && !sessionIds.has(s.id)) {
        sessionIds.add(s.id);
        changed = true;
      }
  }
  return { projectIds, sessionIds };
}

/** Keep execution workspaces under their original project without rebinding sessions. */
export function projectFamilyId(projects: Project[], id?: string | null): string | undefined {
  if (!id) return undefined;
  let current = projects.find((p) => p.id === id);
  const visited = new Set<string>();
  while (current?.sourceProjectId) {
    if (visited.has(current.id)) return id;
    visited.add(current.id);
    const parent = projects.find((p) => p.id === current!.sourceProjectId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? id;
}
