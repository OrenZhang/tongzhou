/** Canvas definitions are independent of their entry point and execution history. */
export type CanvasResource =
  | { kind: 'content'; id: string; version: number }
  | { kind: 'artifact'; id: string }
  | { kind: 'message'; id: string; sessionId: string }
  | { kind: 'file'; projectId: string; path: string; sha256?: string };
export const canvasNodeKinds = {
  text: '文本',
  resource: '资源',
  agent: 'Agent 处理',
  image: '图片生成',
  video: '视频生成',
  save: '保存到内容库',
  plugin: '工具调用',
} as const;
export type CanvasNodeKind = keyof typeof canvasNodeKinds;
export interface CanvasNodePluginDefinition {
  id: string;
  name: string;
  kind: CanvasNodeKind;
  version: number;
  inputs: ('text' | 'image' | 'video' | 'resource')[];
  outputs: ('text' | 'image' | 'video' | 'resource')[];
  configKey?: 'config' | 'media';
  configSchema: Record<string, any>;
}
/** Per-node extension configuration. Service credentials belong to the existing plugin connection. */
export interface CanvasMedia {
  pluginId?: string;
  tool?: string;
  model?: string;
  count?: number;
  mode?: 'text' | 'reference' | 'first-frame' | 'frames' | 'existing';
  referenceImages?: CanvasResource[];
  firstFrame?: CanvasResource;
  lastFrame?: CanvasResource;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  parameters?: Record<string, unknown>;
  destination?:
    | { kind: 'artifacts' }
    | { kind: 'content'; libraryId: string; folderId?: string | null }
    | { kind: 'directory'; path: string };
}
export interface CanvasGenerationItem {
  index: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  resources: CanvasResource[];
  taskSessionId?: string;
  taskRunId?: string;
  remoteTaskId?: string;
  savedPaths?: string[];
  savedContent?: Record<string, string>;
  error?: string;
  phase?: 'generate' | 'save';
  reused?: boolean;
}
export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  pluginId?: string;
  config?: Record<string, unknown>;
  title: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  resource?: CanvasResource;
  media?: CanvasMedia;
  providerId?: string;
  model?: string;
  agentId?: string;
  libraryId?: string;
  folderId?: string | null;
}
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  kind: 'reference' | 'dependency';
}
export interface Canvas {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
  selection: string[];
}
export type CanvasWrite = Omit<Canvas, 'id' | 'version' | 'updatedAt'> & {
  id?: string;
  version?: number;
};
export interface CanvasOutput {
  text: string;
  prompt?: string;
  resources: CanvasResource[];
}
export interface CanvasNodeRun {
  plugin?: { id: string; version: number };
  status: 'pending' | 'running' | 'completed' | 'cached' | 'failed' | 'cancelled';
  generation?: CanvasGenerationItem[];
  generationFingerprint?: string;
  fingerprint?: string;
  inputs?: CanvasOutput[];
  output?: CanvasOutput;
  error?: string;
  taskSessionId?: string;
  taskRunId?: string;
  startedAt?: number;
  endedAt?: number;
}
export interface CanvasRun {
  id: string;
  canvasId: string;
  sessionId: string;
  definition: Canvas;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  nodes: Record<string, CanvasNodeRun>;
  startedAt: number;
  endedAt?: number;
  error?: string;
}
export interface CanvasExecute {
  canvasId: string;
  version: number;
  sessionId: string;
  nodeIds?: string[];
  reuse?: boolean;
  saveResource?: boolean;
  regenerate?: {
    sourceRunId?: string;
    nodeId: string;
    indices?: number[];
    action?: 'generate' | 'resume' | 'save';
  };
  providerId?: string;
  model?: string;
}
export interface CanvasState {
  plugins?: CanvasNodePluginDefinition[];
  canvases: Pick<Canvas, 'id' | 'title' | 'version' | 'updatedAt'>[];
  canvas: Canvas | null;
  runs: CanvasRun[];
}
export interface CanvasOperation {
  type: 'put_node' | 'remove_node' | 'put_edge' | 'remove_edge' | 'select' | 'rename';
  node?: CanvasNode;
  edge?: CanvasEdge;
  id?: string;
  nodeIds?: string[];
  title?: string;
}

/** Only generation tools appear in media pickers; query and image-understanding tools do not. */
export function canvasMediaTools(plugin: import('./types').PluginConfig, kind: 'image' | 'video') {
  return (plugin.catalog ?? []).filter(
    (t) =>
      !t.annotations?.readOnlyHint &&
      !/(query|status|search|understand|describe|read|list|inspect)/i.test(t.name) &&
      (kind === 'image' ? /image|picture|绘图|生图/i : /video|视频/i).test(
        t.name + ' ' + t.description,
      ),
  );
}
