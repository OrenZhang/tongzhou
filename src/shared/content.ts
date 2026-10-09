import type { KnowledgeFolder, KnowledgeSummary } from './knowledge';
export interface ContentLibrary {
  id: string;
  name: string;
  version: number;
}
export interface ContentState {
  libraries: ContentLibrary[];
  folders: KnowledgeFolder[];
  documents: KnowledgeSummary[];
}
export interface ContentWrite {
  id?: string;
  version?: number;
  libraryId: string;
  folderId?: string | null;
  title: string;
  content: string;
  contentType?: string;
  sourceIds?: string[];
}
export interface ContentRun {
  documentId: string;
  version: number;
  providerId: string;
  model: string;
  agentId?: string;
  prompt: string;
  selection?: { start: number; end: number; text: string };
}
