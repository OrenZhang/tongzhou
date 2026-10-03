import type { Project } from './types';

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
