export type TaskSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily' | 'weekly'; time: string; timezone: string; weekdays: number[] };
export const MEMORY_AUTOMATION_ID = 'fe89d222-6dfb-4caa-9363-9f194710303e';
export type AutomationTrigger = 'manual' | 'import' | 'ready' | 'schedule' | 'idle';
export interface AutomationCapability {
  kind: string;
  name: string;
  description: string;
  triggers: AutomationTrigger[];
  builtinRuleId?: string;
}
export interface ContentFlow {
  id: string;
  version: number;
  name: string;
  prompt: string;
  providerId: string;
  model: string;
  agentId?: string;
}
export type ContentFlowInput = Omit<ContentFlow, 'id' | 'version'> & {
  id?: string;
  version?: number;
};
export interface AutomationRule {
  id: string;
  version: number;
  name: string;
  enabled: boolean;
  kind: string;
  trigger: AutomationTrigger;
  flowId?: string;
  libraryId?: string;
  folderId?: string;
  documentId?: string;
  outputFolderId?: string;
  prompt?: string;
  providerId?: string;
  model?: string;
  agentId?: string;
  projectId?: string;
  permission: 'read-only' | 'ask';
  notificationTargetId?: string;
  schedule?: TaskSchedule;
  missed: 'once' | 'skip';
  nextRunAt?: number;
  createdAt: number;
  error?: string;
}
export type AutomationInput = Omit<
  AutomationRule,
  'id' | 'version' | 'nextRunAt' | 'createdAt' | 'error'
> & { id?: string; version?: number };
export interface AutomationJob {
  id: string;
  key: string;
  rule: AutomationRule;
  flow?: ContentFlow;
  source?: { id: string; version: number; title: string; content: string; projectId?: string };
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  sessionId?: string;
  runId?: string;
  outputId?: string;
  result?: string;
  error?: string;
  reviewedAt?: number;
  attempt: number;
  /** Module-owned execution references, never credentials or a second copy of source content. */
  context?: Record<string, string>;
  manual?: boolean;
}
export type AutomationJobView = Omit<AutomationJob, 'source'> & {
  source?: Omit<NonNullable<AutomationJob['source']>, 'content'>;
  sourceState?: 'current' | 'changed' | 'missing';
};
export interface AutomationState {
  capabilities: AutomationCapability[];
  flows: ContentFlow[];
  rules: AutomationRule[];
  jobs: AutomationJobView[];
}
