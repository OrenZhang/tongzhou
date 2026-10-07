import type { KnowledgeDocument, KnowledgeFolder, KnowledgeSummary } from './knowledge';
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
/** Providers implement only supported capabilities; the core never assumes remote write access. */
export interface ContentSourceAdapter {
  id: string;
  capabilities: readonly ('browse' | 'read' | 'pull' | 'push')[];
  browse(parent?: string): Promise<{ id: string; title: string; container: boolean }[]>;
  read(id: string): Promise<{ title: string; content: string; revision?: string; url?: string }>;
  push?(
    document: KnowledgeDocument,
    remoteId?: string,
    expectedRevision?: string,
  ): Promise<{ id: string; revision?: string }>;
}
