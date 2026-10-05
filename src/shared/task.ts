export interface TaskMemory {
  id: string;
  goal: string;
  constraints: string[];
  decisions: string[];
  completed: string[];
  nextSteps: string[];
  sources: string[];
  updatedAt: number;
}
export interface HistoryMatch {
  id: string;
  sessionId: string;
  role: string;
  createdAt: number;
  seq: number;
  excerpt: string;
  totalChars: number;
}
export interface TerminalRecord {
  id: string;
  sessionId: string;
  projectId?: string;
  cwd?: string;
  title: string;
  status: 'running' | 'exited' | 'interrupted';
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  output: string;
  offset: number;
}
export interface RunChanges {
  id: string;
  sessionId: string;
  projectId: string;
  createdAt: number;
  finishedAt?: number;
  skipped: number;
  error?: string;
  files: { path: string; before: string | null; after: string | null; restored?: boolean }[];
}
export interface TaskState {
  cwd: string;
  memory: TaskMemory | null;
  runs: import('./types').Run[];
  terminals: Omit<TerminalRecord, 'output'>[];
  changes: RunChanges[];
  evidence: { id: string; runId?: string; toolName?: string; content: string; status?: string }[];
}
