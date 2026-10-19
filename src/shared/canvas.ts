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
  audio: '音频生成',
  save: '保存到内容库',
  plugin: '工具调用',
} as const;
export type CanvasNodeKind = keyof typeof canvasNodeKinds;
export type CanvasValueType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'resource'
  | 'number'
  | 'boolean'
  | 'json'
  | `comfyui:${string}`;
export interface CanvasPort {
  id: string;
  label: string;
  types: CanvasValueType[];
  description?: string;
  multiple?: boolean;
}
export interface CanvasNodePluginDefinition {
  id: string;
  name: string;
  kind: CanvasNodeKind;
  version: number;
  /** SDK contract version; omitted by legacy registrations (v1). */
  apiVersion?: 1;
  adapter?: 'native' | 'mcp' | 'visual' | 'comfyui';
  description?: string;
  ports?: { inputs: CanvasPort[]; outputs: CanvasPort[] };
  dynamicOutputs?: 'categories';
  /** Static sources can be consumed by reference without running a task. */
  source?: boolean;
  /** External effects and time-dependent nodes must execute on every run. */
  cache?: 'never';
  view?: { renderer: string; textLabel?: string; resource?: 'image' };
  defaults?: Pick<CanvasNode, 'text' | 'config' | 'width' | 'height'>;
  inputs: CanvasValueType[];
  outputs: CanvasValueType[];
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
  voice?: string;
  speed?: number;
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
  /** Declarative definition snapshot for imported nodes; executable code stays in the registry. */
  definition?: CanvasNodePluginDefinition;
  title: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  group?: string;
  text?: string;
  resource?: CanvasResource;
  /** Editable snapshot provenance. Execution uses text; refreshing is explicit. */
  textSource?: { title: string; url?: string };
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
  fromPort?: string;
  toPort?: string;
}
export interface Canvas {
  mode?: 'workflow' | 'whiteboard';
  whiteboard?: import('./whiteboard').WhiteboardScene;
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
  value?: unknown;
  prompt?: string;
  resources: CanvasResource[];
  inputPort?: string;
  ports?: Record<
    string,
    {
      text: string;
      value?: unknown;
      resources: CanvasResource[];
      items?: { name: string; description: string }[];
    }
  >;
}
export interface CanvasNodeRun {
  progress?: { value: number; max: number };
  externalStatus?: string;
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
  external?: Record<
    string,
    {
      connectionId: string;
      promptId?: string;
      clientId: string;
      fingerprint: string;
      nodeIds: string[];
      submittedAt: number;
      uncertain?: boolean;
      submittedPrompt?: Record<string, unknown>;
      controls?: Record<string, { base: number; value: number; mode: string }>;
    }
  >;
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
  /** Query an existing external task without submitting again. */
  resumeRunId?: string;
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
  canvases: Pick<Canvas, 'id' | 'title' | 'version' | 'updatedAt' | 'mode'>[];
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
export function canvasMediaTools(
  plugin: import('./types').PluginConfig,
  kind: 'image' | 'video' | 'audio',
) {
  return (plugin.catalog ?? []).filter(
    (t) =>
      !t.annotations?.readOnlyHint &&
      !/(query|status|search|understand|describe|read|list|inspect)/i.test(t.name) &&
      (kind === 'image'
        ? /image|picture|绘图|生图/i
        : kind === 'audio'
          ? /audio|speech|tts|music|语音|配音|音乐/i
          : /video|视频/i
      ).test(t.name + ' ' + t.description),
  );
}
