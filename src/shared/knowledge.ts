export type KnowledgeKind = 'source' | 'wiki' | 'memory';
export interface KnowledgeFolder {
  /** Legacy storage field, ignored. Directory use no longer requires a switch. */
  usageEnabled?: boolean;
  libraryId?: string;
  id: string;
  name: string;
  parentId?: string;
  version: number;
}
export interface KnowledgeFolderInput {
  libraryId?: string;
  id?: string;
  name: string;
  parentId?: string | null;
  version?: number;
}
export function knowledgeFolderPath(folders: KnowledgeFolder[], id?: string | null): string {
  const names: string[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = folders.find((f) => f.id === id);
    if (!folder) break;
    names.unshift(folder.name);
    id = folder.parentId;
  }
  return names.join(' / ');
}
export function knowledgeFolderBranch(folders: KnowledgeFolder[], id: string): Set<string> {
  const branch = new Set([id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && branch.has(folder.parentId) && !branch.has(folder.id)) {
        branch.add(folder.id);
        changed = true;
      }
    }
  }
  return branch;
}
// archived is retained only for reading legacy data and revisions.
export type KnowledgeStatus = 'ready' | 'draft' | 'archived';
export type MemoryCategory = 'preference' | 'fact' | 'decision' | 'lesson' | 'todo' | 'conflict';
export const memoryCategories: Record<MemoryCategory, string> = {
  preference: '偏好与约束',
  fact: '事实与背景',
  decision: '决策',
  lesson: '经验与方法',
  todo: '待办与缺口',
  conflict: '矛盾与变化',
};
export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  subject: string;
  relation: string;
  content: string;
  projectId?: string;
  sessionId: string;
  scopeLabel?: string;
  sources: KnowledgeSource[];
  occurredAt: number;
  reviewedAt?: number;
  quotes?: string[];
}
export interface KnowledgeReference {
  id: string;
  title: string;
  version: number;
  mode: 'explicit' | 'automatic' | 'tool';
  excerpt: string;
}
export interface KnowledgeSource {
  id: string;
  title: string;
  version?: number;
  sessionId?: string;
  messageId?: string;
}
export interface KnowledgeDocument {
  derivationKey?: string;
  derivation?: {
    batchId: string;
    index: number;
    createdAt: number;
    sourceId: string;
    sourceVersion: number;
    mode: 'split' | 'transform';
    start?: number;
    end?: number;
  };
  libraryId?: string;
  contentType?: string;
  id: string;
  title: string;
  kind: KnowledgeKind;
  folderId?: string;
  status: KnowledgeStatus;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  tags: string[];
  content: string;
  assertions?: import('./ontology').KnowledgeAssertion[];
  sources: KnowledgeSource[];
  version: number;
  createdAt: number;
  updatedAt: number;
  origin: 'manual' | 'import' | 'agent' | 'automatic';
  fileName?: string;
  blob?: string;
  hash?: string;
  indexed?: boolean;
  archivedStatus?: Exclude<KnowledgeStatus, 'archived'>;
  memoryDate?: string;
  memoryEntries?: MemoryEntry[];
  memoryCandidateIds?: string[];
  forgottenMemoryKeys?: string[];
  reviewedAt?: number;
  reviewedSourceVersions?: Record<string, number | null>;
}
export type KnowledgeSummary = Omit<
  KnowledgeDocument,
  'content' | 'memoryEntries' | 'memoryCandidateIds' | 'assertions' | 'forgottenMemoryKeys'
> & { excerpt: string };
export interface KnowledgeInput {
  libraryId?: string;
  contentType?: string;
  id?: string;
  version?: number;
  title: string;
  content: string;
  kind: KnowledgeKind;
  folderId?: string | null;
  projectId?: string;
  tags?: string[];
  status?: KnowledgeStatus;
  sourceIds?: string[];
  assertions?: import('./ontology').KnowledgeAssertion[];
}
export interface KnowledgeSettings {
  autoCollect: boolean;
}
export interface KnowledgeState {
  root: string;
  settings: KnowledgeSettings;
  documents: KnowledgeSummary[];
  folders: KnowledgeFolder[];
  total: number;
  issues: { id: string; title: string; reason: string }[];
  memoryQueue: {
    pending: number;
    running: number;
    failed: number;
    completed: number;
    lastError?: string;
    lastResult?: string;
  };
}
export interface KnowledgeRead {
  document: KnowledgeDocument;
  links: { target: string; id?: string; ambiguous: boolean }[];
  missingSourceIds: string[];
  changedSourceIds?: string[];
  revisions: { id: string; version: number; updatedAt: number }[];
  backlinks: KnowledgeSummary[];
  outline: { title: string; line: number; level: number }[];
}

/** Omit obsolete permission flags from tool results, including legacy stored directories. */
export function knowledgeFolderForTool(folder: KnowledgeFolder, folders: KnowledgeFolder[]) {
  const { usageEnabled: _legacyFlag, ...value } = folder;
  return { ...value, path: knowledgeFolderPath(folders, folder.id) };
}
