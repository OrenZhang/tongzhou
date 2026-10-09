import type { ProviderNetwork } from '../../src/shared/provider-network';
import type {
  AgentProfile,
  Message,
  PendingInput,
  PermissionMode,
  Project,
  Run,
  RunEvent,
  RunInput,
  Snapshot,
} from '../../src/shared/types';
import type { ToolScope } from './tools/extensions';

export interface TaskService {
  start(input: RunInput, resendMessageId?: string): string;
  enqueue(input: RunInput, mode: PendingInput['mode']): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  team(input: RunInput, agentIds: string[]): Promise<string>;
  cancelInput(id: string): void;
  editInput(id: string, prompt: string): void;
  resumeInput(id: string): void;
  events(sessionId: string, before?: string): RunEvent[];
  snapshot(): Snapshot;
  setSessionPermission(id: string, permission: PermissionMode | null): void;
  setDefaultPermission(permission: PermissionMode, applyToAll?: boolean): void;
  isActive(id: string): boolean;
  stop(): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface ChangePublisher {
  changed(): void;
}
export interface ExecutionAdapter {
  run(
    input: RunInput,
    project: Project | null,
    agent: AgentProfile,
    run: Run,
    signal: AbortSignal,
    scope: ToolScope,
  ): Promise<void>;
  hasSteering(sessionId: string): boolean;
  steer(
    sessionId: string,
    text: string,
    messageId: string,
    attachmentIds?: string[],
  ): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  invalidate(providerId?: string): Promise<void>;
  close(): Promise<void>;
}
export interface ExecutionCallbacks {
  isStopping(): boolean;
  ask(
    sessionId: string,
    title: string,
    detail: string,
    signal: AbortSignal,
    force?: boolean,
  ): Promise<boolean>;
  progress(run: Run, type: RunEvent['type'], text: string): void;
  add(sessionId: string, role: Message['role'], content: string, extra?: Partial<Message>): Message;
  appendText(message: Message, text: string): void;
  message(message: Message): void;
  finishText(message: Message, text: string): void;
}

export interface ExecutionNetwork {
  resolve(network?: ProviderNetwork, runId?: string): Promise<ProviderNetwork | undefined>;
  transport?(network?: ProviderNetwork): Promise<typeof fetch>;
}

/** Per-run tool preparation supplied by the application composition layer. */
export type TaskToolPreparation = (context: {
  scope: ToolScope;
  session: import('../../src/shared/types').Session;
  agent: import('../../src/shared/types').AgentProfile;
  project: import('../../src/shared/types').Project | null;
  run: import('../../src/shared/types').Run;
  signal: AbortSignal;
  ask(title: string, detail: string): Promise<boolean>;
  progress(text: string): void;
}) => Promise<void>;
