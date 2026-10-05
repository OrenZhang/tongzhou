export type KnowledgeKind = 'source' | 'wiki' | 'memory';
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
  id: string;
  title: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  tags: string[];
  content: string;
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
  reviewedAt?: number;
  reviewedSourceVersions?: Record<string, number | null>;
}
export type KnowledgeSummary = Omit<
  KnowledgeDocument,
  'content' | 'memoryEntries' | 'memoryCandidateIds'
> & { excerpt: string };
export interface KnowledgeInput {
  id?: string;
  version?: number;
  title: string;
  content: string;
  kind: KnowledgeKind;
  projectId?: string;
  tags?: string[];
  status?: KnowledgeStatus;
  sourceIds?: string[];
}
export interface KnowledgeSettings {
  autoCollect: boolean;
  autoContext: boolean;
}
export interface KnowledgeState {
  root: string;
  settings: KnowledgeSettings;
  documents: KnowledgeSummary[];
  archived: KnowledgeSummary[];
  total: number;
  issues: { id: string; title: string; reason: string }[];
  pinned: string[];
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
  missingSourceIds: string[];
  revisions: { id: string; version: number; updatedAt: number }[];
  backlinks: KnowledgeSummary[];
  outline: { title: string; line: number; level: number }[];
}
