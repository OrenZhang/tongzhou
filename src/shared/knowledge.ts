export type KnowledgeKind = 'source' | 'wiki' | 'memory';
export type KnowledgeStatus = 'ready' | 'draft' | 'archived';
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
}
export type KnowledgeSummary = Omit<KnowledgeDocument, 'content'> & { excerpt: string };
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
}
export interface KnowledgeRead {
  document: KnowledgeDocument;
  revisions: { id: string; version: number; updatedAt: number }[];
  backlinks: KnowledgeSummary[];
  outline: { title: string; line: number; level: number }[];
}
