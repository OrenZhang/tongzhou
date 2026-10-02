export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini' | 'codex';
export type AuthMode = 'api-key' | 'bearer' | 'none' | 'chatgpt';
export interface Provider {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  auth: AuthMode;
  models: string[];
  hasSecret?: boolean;
  maxOutputTokens: number;
  contextChars: number;
}
export interface ProviderInput extends Provider {
  secret?: string;
  clearSecret?: boolean;
}
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  providerId: string;
  model: string;
  permission: 'read-only' | 'ask';
  maxSteps: number;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  signature?: string;
  signatureModel?: string;
}
export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: number;
  runId?: string;
  model?: string;
  providerId?: string;
  agent?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  status?: 'streaming' | 'complete' | 'interrupted' | 'error';
}
export interface Session {
  id: string;
  projectId: string | null;
  title: string;
  providerId: string;
  model: string;
  agentId: string;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}
export interface Run {
  id: string;
  sessionId: string;
  providerId: string;
  model: string;
  agentName: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  startedAt: number;
  endedAt?: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  config?: {
    protocol: Protocol;
    baseUrl: string;
    instructions: string;
    permission: AgentProfile['permission'];
    maxSteps: number;
  };
}
export interface Approval {
  id: string;
  sessionId: string;
  title: string;
  detail: string;
}
export interface Snapshot {
  providers: Provider[];
  agents: AgentProfile[];
  projects: Project[];
  sessions: Session[];
  runs: Run[];
  approvals: Approval[];
}
export type CodexLoginMethod = 'browser' | 'device';
export interface CodexAuthState {
  available: boolean;
  account: string;
  plan?: string;
  error?: string;
  login?: {
    method: CodexLoginMethod;
    phase: 'starting' | 'waiting' | 'success' | 'error' | 'cancelled';
    url?: string;
    userCode?: string;
    error?: string;
  };
}
export type AppEvent =
  | { type: 'codex-auth'; state: CodexAuthState }
  | { type: 'changed' }
  | { type: 'message'; message: Message }
  | { type: 'approval'; approval: Approval };
export interface RunInput {
  sessionId: string;
  prompt: string;
  providerId: string;
  model: string;
  agentId: string;
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
}
export interface ImportPreview {
  providers: ProviderInput[];
  warnings: string[];
}
export interface TongzhouAPI {
  snapshot(): Promise<Snapshot>;
  messages(sessionId: string): Promise<Message[]>;
  saveProvider(provider: ProviderInput): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  testProvider(id: string, model: string): Promise<string>;
  models(id: string): Promise<string[]>;
  saveAgent(agent: AgentProfile): Promise<AgentProfile>;
  deleteAgent(id: string): Promise<void>;
  addProject(): Promise<Project | null>;
  createSession(projectId?: string | null): Promise<Session>;
  updateSession(id: string, patch: { title?: string; archived?: boolean }): Promise<void>;
  run(input: RunInput): Promise<string>;
  team(input: RunInput, agentIds: string[]): Promise<string>;
  cancel(sessionId: string): Promise<void>;
  approve(id: string, allow: boolean): Promise<void>;
  listFiles(projectId: string, path: string): Promise<FileEntry[]>;
  readFile(projectId: string, path: string): Promise<string>;
  diff(projectId: string): Promise<string>;
  importCCSwitch(): Promise<ImportPreview | null>;
  exportSession(id: string): Promise<string | null>;
  codexStatus(): Promise<CodexAuthState>;
  codexLogin(method: CodexLoginMethod): Promise<CodexAuthState>;
  codexLoginCancel(): Promise<void>;
  codexLoginOpen(): Promise<void>;
  codexLoginCopyCode(): Promise<void>;
  codexLogout(): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global {
  interface Window {
    tongzhou: TongzhouAPI;
  }
}
