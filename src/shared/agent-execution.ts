export interface UserQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
}
export type QuestionAnswers = Record<string, string[]>;
export interface QuestionRequest {
  threadId: string;
  questions: unknown;
  isBlocking: boolean;
  autoResolutionMs?: number | null;
  delivery?: 'async';
}

export interface ChildAgent {
  usageTotal?: { inputTokens: number; outputTokens: number };
  phase?: string;
  inputTokens?: number;
  outputTokens?: number;
  usageReported?: boolean;
  startedAt?: number;
  endedAt?: number;
  path?: string;
  directInput?: boolean;
  pendingAction?: 'resume';
  threadId: string;
  parentThreadId: string;
  name: string;
  model?: string;
  reasoningEffort?: string;
  turnId?: string;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed' | 'closed';
  message?: string;
}

export interface ExecutionObservation {
  usageIncomplete?: boolean;
  threadId: string;
  turnId?: string;
  actualModel: string;
  reroutes: { fromModel: string; toModel: string; reason: string }[];
  compactions: number;
}
