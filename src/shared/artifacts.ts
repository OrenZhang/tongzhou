export type ArtifactKind =
  | 'image'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'audio'
  | 'video'
  | 'file';
export const artifactKinds: Record<ArtifactKind, string> = {
  image: '图片',
  document: '文档',
  spreadsheet: '表格',
  presentation: '演示文稿',
  audio: '音频',
  video: '视频',
  file: '其他文件',
};
export interface Artifact {
  id: string;
  name: string;
  kind: ArtifactKind;
  mimeType: string;
  size?: number;
  createdAt: number;
  sessionId: string;
  runId: string;
  projectId?: string;
  model: string;
  toolName?: string;
  remoteUrl?: string;
}
/** Transient tool result. Bytes are copied into managed storage, never persisted in chat JSON. */
export interface ArtifactOutput {
  name: string;
  mimeType?: string;
  data?: string;
  text?: string;
  path?: string;
  url?: string;
}
export interface ArtifactQuery {
  sessionId?: string;
  projectId?: string;
  kind?: ArtifactKind;
  query?: string;
  offset?: number;
  createdAfter?: number;
  createdBefore?: number;
}
export interface ArtifactPage {
  items: Artifact[];
  total: number;
  nextOffset: number | null;
}
export interface ArtifactPreview {
  type: 'image' | 'text' | 'external' | 'file';
  content?: string;
}

export function artifactDay(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function artifactDateRange(
  day: string,
): Pick<ArtifactQuery, 'createdAfter' | 'createdBefore'> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return {};
  const [y, m, d] = day.split('-').map(Number);
  return {
    createdAfter: new Date(y, m - 1, d).getTime(),
    createdBefore: new Date(y, m - 1, d + 1).getTime(),
  };
}
