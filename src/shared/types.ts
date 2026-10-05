import type {
  KnowledgeState,
  KnowledgeRead,
  KnowledgeDocument,
  KnowledgeInput,
  KnowledgeSettings,
} from './knowledge';
export type NativeEngine = 'kimi' | 'minimax';
export interface NativeAuthState {
  providerId?: string;
  engine: NativeEngine;
  phase: 'idle' | 'starting' | 'waiting' | 'checking' | 'success' | 'error' | 'cancelled';
  authenticated: boolean;
  region?: 'cn' | 'global';
  url?: string;
  userCode?: string;
  error?: string;
}
export type Protocol =
  | NativeEngine
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'codex';
export type AuthMode = 'api-key' | 'bearer' | 'none' | 'chatgpt' | 'native';
export interface Provider {
  /** Missing on older connections means enabled. */
  thinkingEnabled?: boolean;
  /** Existing connections without this field remain enabled. */
  enabled?: boolean;
  network?: import('./provider-network').ProviderNetwork;
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  auth: AuthMode;
  models: string[];
  modelLabels?: Record<string, string>;
  hasSecret?: boolean;
  maxOutputTokens: number;
  /** 0 = automatic compaction; positive = manual character target (never a turn limit). */
  contextChars: number;
}
export interface ProviderInput extends Provider {
  secret?: string;
  clearSecret?: boolean;
}
export type PermissionMode = 'read-only' | 'ask' | 'full-access';
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  providerId: string;
  model: string;
  permission: PermissionMode;
  /** Model response rounds; 0 has no local round limit. Not a tool-call quota. */
  maxSteps: number;
  pluginIds?: string[];
  skillIds?: string[];
  computerEnabled?: boolean;
}
export interface PluginConfig {
  authMode?: 'headers' | 'oauth';
  oauthClientId?: string;
  oauthIssuer?: string;
  oauthStatus?: 'none' | 'starting' | 'waiting' | 'authorized' | 'error' | 'cancelled';
  oauthError?: string;
  hasOAuthClientSecret?: boolean;
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  readOnlyTools: string[];
  hasSecret?: boolean;
  catalog?: { name: string; description: string; inputSchema: Record<string, any> }[];
  checkedAt?: number;
}
export interface PluginInput extends PluginConfig {
  oauthClientSecret?: string;
  clearOAuthClientSecret?: boolean;
  secret?: string;
  clearSecret?: boolean;
}
export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  files: Record<string, string>;
}
export interface ToolImage {
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}
export interface Attachment {
  id: string;
  name: string;
  mimeType: ToolImage['mimeType'] | 'text/plain';
  size: number;
}
export interface AttachmentUpload {
  name: string;
  mimeType: Attachment['mimeType'];
  data: string;
}
export interface ToolOutput {
  text: string;
  images?: ToolImage[];
  isError?: boolean;
}
export interface ComputerStatus {
  diagnostic?: { ok: boolean; time: number; detail: string };
  supported: boolean;
  platform: string;
  screen: string;
  accessibility: boolean;
  emergencyShortcut: boolean;
}
export interface Project {
  gitConnectorId?: string;
  sourceProjectId?: string;
  removed?: boolean;
  id: string;
  name: string;
  path: string;
  createdAt: number;
}
export interface GitRepositoryInfo {
  branch: string;
  remote: string;
  connectorId: string;
  dirty: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  signature?: string;
  signatureModel?: string;
}
export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  main: boolean;
  managed: boolean;
  projectId?: string;
  dirty: boolean;
  locked: boolean;
  prunable: boolean;
  unsharedCommits: boolean;
}
export interface Message {
  attachments?: Attachment[];
  // Presentation order within a run; protocol content remains unchanged.
  sequence?: number;
  segments?: { seq: number; start: number; end: number; time: number }[];
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
  anthropicContent?: Record<string, any>[];
  reasoningContent?: string;
  responseReasoning?: Record<string, any>[];
  toolCallId?: string;
  toolName?: string;
  status?: 'streaming' | 'complete' | 'interrupted' | 'error';
  images?: ToolImage[];
  visibleTool?: boolean;
}
export interface Session {
  knowledgeJob?: boolean;
  permission?: PermissionMode;
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
  usageReported?: boolean;
  workspace?: { before: string; after?: string };
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
  phase?: string;
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
  bots?: BotConfig[];
  defaultPermission?: PermissionMode;
  channelAuth?: { id: string; phase: string; expiresAt?: number }[];
  connectors?: Connector[];
  channels?: Channel[];
  notificationRules?: NotificationRule[];
  deliveries?: Delivery[];
  authEvents?: { id: string; providerId: string; phase: string; time: number; error?: string }[];
  capabilities?: { computer: boolean; management: boolean };
  pendingInputs?: PendingInput[];
  plugins?: PluginConfig[];
  skills?: SkillRecord[];
  providers: Provider[];
  agents: AgentProfile[];
  projects: Project[];
  sessions: Session[];
  runs: Run[];
  approvals: Approval[];
}
export type CodexLoginMethod = 'browser' | 'device';
export interface CodexAuthState {
  providerId?: string;
  available: boolean;
  account: string;
  plan?: string;
  error?: string;
  login?: {
    method: CodexLoginMethod;
    phase: 'starting' | 'waiting' | 'checking' | 'success' | 'error' | 'cancelled';
    url?: string;
    userCode?: string;
    error?: string;
  };
}
export type AppEvent =
  | { type: 'appearance'; value: Partial<import('./appearance').AppearancePreferences> }
  | {
      type: 'navigate';
      view:
        | 'workspace'
        | 'providers'
        | 'agents'
        | 'activity'
        | 'settings'
        | 'connections'
        | 'extensions'
        | 'knowledge';
    }
  | { type: 'run-event'; event: RunEvent }
  | { type: 'native-auth'; state: NativeAuthState }
  | { type: 'codex-auth'; state: CodexAuthState }
  | { type: 'changed' }
  | { type: 'message'; message: Message }
  | { type: 'approval'; approval: Approval };
export interface RunInput {
  attachmentIds?: string[];
  sessionId: string;
  prompt: string;
  providerId: string;
  model: string;
  agentId: string;
}
export interface RunEvent {
  id: string;
  sessionId: string;
  runId: string;
  seq: number;
  time: number;
  type: 'phase' | 'reasoning' | 'tool' | 'input' | 'notice';
  text: string;
}
export interface PendingInput {
  id: string;
  sessionId: string;
  input: RunInput;
  mode: 'supplement' | 'next' | 'restart';
  status: 'queued' | 'dispatching' | 'applied' | 'cancelled' | 'paused';
  createdAt: number;
  runId?: string;
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
  knowledgeReferences(sessionId: string): Promise<string[]>;
  knowledgeCollect(sessionId: string): Promise<{ collected: number }>;
  knowledgeState(query?: string, projectId?: string, sessionId?: string): Promise<KnowledgeState>;
  knowledgeRead(id: string): Promise<KnowledgeRead>;
  knowledgeSave(input: KnowledgeInput): Promise<KnowledgeDocument>;
  knowledgeArchive(id: string, archived: boolean): Promise<void>;
  knowledgeRestore(id: string, version: number, currentVersion: number): Promise<KnowledgeDocument>;
  knowledgeBind(sessionId: string, documentIds: string[]): Promise<void>;
  knowledgeSettings(value: KnowledgeSettings): Promise<void>;
  knowledgeReindex(): Promise<{ indexed: number }>;
  knowledgeImport(projectId?: string): Promise<{ imported: KnowledgeDocument[]; errors: string[] }>;
  knowledgeOpenFolder(): Promise<void>;
  knowledgeOrganize(sessionId: string, documentIds: string[]): Promise<string>;

  diagnoseProvider(
    id: string,
    model: string,
    inference: boolean,
  ): Promise<import('../ConnectionDiagnostics').ConnectionCheck[]>;
  browserDownloads(id: string): Promise<any[]>;
  browserSnapshot(id: string): Promise<any>;
  browserAction(
    id: string,
    input: {
      frame: string;
      ref: number;
      action: 'click' | 'fill' | 'select' | 'focus';
      text?: string;
    },
  ): Promise<any>;
  browserNavigate(id: string, url: string): Promise<any>;
  browserPress(id: string, key: string): Promise<any>;
  taskState(id: string): Promise<import('./task').TaskState>;
  searchMessages(
    query: string,
    sessionId?: string,
    before?: number,
  ): Promise<import('./task').HistoryMatch[]>;
  historyMessage(
    sessionId: string,
    messageId: string,
    offset?: number,
  ): Promise<{ content: string; nextOffset: number | null; totalChars: number }>;
  resumeTask(id: string): Promise<string>;
  startTerminal(id: string): Promise<import('./task').TerminalRecord>;
  readTerminal(
    id: string,
    terminal: string,
    offset?: number,
  ): Promise<import('./task').TerminalRecord & { nextOffset: number }>;
  writeTerminal(id: string, terminal: string, data: string): Promise<void>;
  resizeTerminal(id: string, terminal: string, cols: number, rows: number): Promise<void>;
  stopTerminal(id: string, terminal: string): Promise<void>;
  runPatch(id: string, file: string): Promise<string>;
  restoreRunFile(id: string, file: string): Promise<string>;
  stageRunFile(id: string, file: string): Promise<string>;
  reviewStaged(id: string): Promise<{ patch: string; hash: string }>;
  commitStaged(id: string, message: string, expected: string): Promise<string>;
  backupWorkspace(password: string): Promise<string | null>;
  restoreWorkspace(password: string): Promise<string | null>;
  exportDiagnostics(): Promise<string | null>;
  cleanUnusedData(): Promise<{ files: number; bytes: number }>;
  checkRelease(): Promise<{ current: string; latest: string | null; url: string }>;

  uploadAttachment(value: AttachmentUpload): Promise<Attachment>;
  attachmentContent(id: string): Promise<string>;
  clientMethods(): Promise<import('./client-catalog').ClientCatalog>;
  getAppearance(): Promise<Partial<import('./appearance').AppearancePreferences>>;
  setAppearance(value: import('./appearance').AppearancePreferences): Promise<void>;
  gitRepository(projectId: string): Promise<GitRepositoryInfo>;
  bindGitAccount(projectId: string, connectorId: string): Promise<void>;
  syncRepository(projectId: string, action: 'pull' | 'push'): Promise<string>;
  cloneRepository(connectorId: string, url: string, directory: string): Promise<Project>;
  chooseCloneDirectory(): Promise<string | null>;
  loginPlugin(id: string): Promise<{ url?: string; browserOpened?: boolean }>;
  logoutPlugin(id: string): Promise<void>;
  cancelPluginLogin(id: string): Promise<void>;
  useGithubConnector(pluginId: string, connectorId: string): Promise<void>;
  listWorktrees(projectId: string): Promise<WorktreeInfo[]>;
  createWorktree(projectId: string, branch: string, ref: string): Promise<Project>;
  removeWorktree(projectId: string): Promise<void>;
  openProjectFolder(projectId: string): Promise<void>;
  saveBot(input: BotConfig & { secret?: string }): Promise<void>;
  deleteBot(id: string): Promise<void>;
  restartBot(id: string): Promise<void>;
  onboardBot(
    id: string,
    name: string,
  ): Promise<{ id: string; url: string; image: string; expiresAt: number }>;
  setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>;
  copyText(text: string): Promise<void>;
  openExternalLink(url: string): Promise<void>;
  setDefaultPermission(mode: PermissionMode, applyToAll?: boolean): Promise<void>;
  setSessionPermission(sessionId: string, mode: PermissionMode | null): Promise<void>;
  openModule(view: string): Promise<void>;
  installBuiltinPlugin(): Promise<void>;
  onboardFeishu(
    id: string,
    name: string,
  ): Promise<{ id: string; url: string; image: string; expiresAt: number }>;
  cancelChannelLogin(id: string): Promise<void>;
  saveConnector(input: Connector & { secret?: string; clearSecret?: boolean }): Promise<void>;
  deleteConnector(id: string): Promise<void>;
  testConnector(id: string): Promise<string>;
  loginConnector(id: string): Promise<{ url: string; code: string; expiresAt: number }>;
  cancelConnectorLogin(id: string): Promise<void>;
  openBrowserProfile(
    id: string,
  ): Promise<{ connectorId: string; opened: boolean; reused: boolean }>;
  clearBrowserProfile(id: string): Promise<void>;
  saveChannel(
    input: Channel & { webhook?: string; signingSecret?: string; password?: string },
  ): Promise<void>;
  testEmail(id: string): Promise<string>;
  deleteChannel(id: string): Promise<void>;
  sendChannel(id: string, text: string, sessionId?: string): Promise<Delivery>;
  saveNotificationRule(rule: NotificationRule): Promise<void>;
  deleteNotificationRule(id: string): Promise<void>;
  initializeAgent(projectId: string): Promise<{ path: string; created: boolean }>;
  branchSession(sessionId: string, messageId: string): Promise<Session>;
  setCapability(name: 'computer' | 'management', enabled: boolean): Promise<void>;
  runEvents(sessionId: string, before?: string): Promise<RunEvent[]>;
  enqueue(input: RunInput, mode: PendingInput['mode']): Promise<void>;
  cancelInput(id: string): Promise<void>;
  resumeInput(id: string): Promise<void>;
  editInput(id: string, prompt: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  savePlugin(plugin: PluginInput): Promise<void>;
  deletePlugin(id: string): Promise<void>;
  testPlugin(id: string): Promise<{ name: string; description: string }[]>;
  importSkill(): Promise<SkillRecord | null>;
  saveSkill(skill: SkillRecord): Promise<void>;
  deleteSkill(id: string): Promise<void>;
  computerStatus(): Promise<ComputerStatus>;
  computerPermission(): Promise<ComputerStatus>;
  computerSelfTest(): Promise<ComputerStatus>;
  emergencyStop(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  messages(sessionId: string, options?: { before?: string; limit?: number }): Promise<Message[]>;
  saveProvider(provider: ProviderInput): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  testProvider(id: string, model: string): Promise<string>;
  testProviderNetwork(id: string): Promise<string>;
  networkProfiles(): Promise<import('./network-profile').NetworkOverview>;
  saveNetworkProfile(input: import('./network-profile').NetworkProfileInput): Promise<void>;
  deleteNetworkProfile(id: string): Promise<void>;
  refreshNetworkProfile(id: string): Promise<void>;
  startNetworkProfile(id: string): Promise<void>;
  stopNetworkProfile(id: string): Promise<void>;
  selectNetworkNode(id: string, node: string): Promise<void>;
  testNetworkProfile(id: string): Promise<string>;
  checkNetworkNodes(id: string, node?: string): Promise<string>;
  cancelNetworkCheck(id: string): Promise<void>;
  setNetworkRouting(id: string, routing: 'manual' | 'auto'): Promise<void>;
  installNetworkCore(offline: boolean): Promise<string>;
  models(id: string): Promise<string[]>;
  saveAgent(agent: AgentProfile): Promise<AgentProfile>;
  deleteAgent(id: string): Promise<void>;
  addProject(): Promise<Project | null>;
  createSession(projectId?: string | null): Promise<Session>;
  updateSession(
    id: string,
    patch: { title?: string; archived?: boolean; providerId?: string; model?: string },
  ): Promise<void>;
  run(input: RunInput): Promise<string>;
  team(input: RunInput, agentIds: string[]): Promise<string>;
  cancel(sessionId: string): Promise<void>;
  approve(id: string, allow: boolean): Promise<void>;
  listFiles(projectId: string, path: string): Promise<FileEntry[]>;
  readFile(projectId: string, path: string): Promise<string>;
  diff(projectId: string): Promise<string>;
  projectChanges(
    projectId: string,
    scope: import('./project-context').ChangeScope,
  ): Promise<import('./project-context').ProjectChanges>;
  projectPatch(
    projectId: string,
    path: string,
    scope: import('./project-context').ChangeScope,
  ): Promise<import('./project-context').ProjectPatch>;
  projectSearch(
    projectId: string,
    query: string,
    mode: 'path' | 'content',
  ): Promise<import('./project-context').ProjectSearch>;
  projectInstructions(projectId: string): Promise<import('./project-context').ProjectInstruction[]>;
  importCCSwitch(): Promise<ImportPreview | null>;
  exportSession(id: string): Promise<string | null>;
  nativeStatus(engine: NativeEngine, providerId?: string): Promise<NativeAuthState>;
  nativeLogin(
    engine: NativeEngine,
    region: 'cn' | 'global',
    providerId?: string,
  ): Promise<NativeAuthState>;
  nativeCancel(engine: NativeEngine, providerId?: string): Promise<void>;
  nativeOpen(engine: NativeEngine, providerId?: string): Promise<void>;
  nativeCopyCode(engine: NativeEngine, providerId?: string): Promise<void>;
  nativeLogout(engine: NativeEngine, providerId?: string): Promise<void>;
  codexStatus(providerId?: string): Promise<CodexAuthState>;
  codexLogin(method: CodexLoginMethod, providerId?: string): Promise<CodexAuthState>;
  codexLoginRetry(method: CodexLoginMethod, providerId?: string): Promise<CodexAuthState>;
  codexLoginCancel(providerId?: string): Promise<void>;
  codexLoginOpen(providerId?: string): Promise<void>;
  codexLoginCopyCode(providerId?: string): Promise<void>;
  codexLogout(providerId?: string): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}

export interface Connector {
  id: string;
  name: string;
  kind: 'github' | 'gitlab' | 'browser';
  enabled: boolean;
  baseUrl: string;
  clientId?: string;
  hasSecret?: boolean;
  status?: 'configured' | 'connected' | 'error';
  account?: string;
  checkedAt?: number;
}
export interface BotConfig {
  id: string;
  name: string;
  kind: 'feishu' | 'wecom' | 'dingtalk';
  appId: string;
  domain?: 'feishu' | 'lark';
  enabled: boolean;
  allowedSenders: string[];
  allowedChats: string[];
  allSessions: boolean;
  sessionIds: string[];
  allowExecute: boolean;
  defaultProjectId?: string;
  status?: 'disabled' | 'connecting' | 'listening' | 'connected' | 'error';
  error?: string;
  lastMessageAt?: number;
  hasSecret?: boolean;
}
export interface Channel {
  id: string;
  name: string;
  kind: 'feishu' | 'wecom' | 'dingtalk' | 'email';
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    from: string;
    to: string[];
    subject: string;
  };
  enabled: boolean;
  status?: 'configured' | 'authorized' | 'connected';
  mode?: 'webhook' | 'app';
  appId?: string;
  domain?: 'feishu' | 'lark';
  receiveId?: string;
  receiveIdType?: 'chat_id' | 'open_id';
  inbound?: boolean;
  sessionId?: string;
  allowedSenders?: string[];
  checkedAt?: number;
}
export interface NotificationRule {
  id: string;
  channelId: string;
  sessionId: string | null;
  enabled: boolean;
  once: boolean;
  events: ('completed' | 'failed' | 'interrupted' | 'approval' | 'ended')[];
  projectId?: string;
  models?: string[];
  minDurationSeconds?: number;
  targetRunId?: string;
  template: string;
}
export interface Delivery {
  id: string;
  channelId: string;
  sessionId?: string;
  ruleId?: string;
  key: string;
  time: number;
  status: 'sending' | 'sent' | 'failed' | 'unknown';
  error?: string;
}
declare global {
  interface Window {
    tongzhou: TongzhouAPI;
  }
}
