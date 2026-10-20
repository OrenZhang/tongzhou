import type { PowerSettings } from '../services/desktop/power';
import type { Updates } from '../services/desktop/updates';
import type { AppEvent, ProviderInput } from '../../src/shared/types';
import type { Accounts, AccountBrowserHost } from '../services/accounts/accounts';
import type { TaskService } from '../core/task-contracts';
import type { DomainServices } from '../modules/domain-services';
import type { Automations } from '../modules/automation/automations';
import type { SessionLifecycle } from '../modules/sessions/session-lifecycle';
import type { ApprovalQueue } from '../core/runtime/approval-queue';
import type { Terminals } from '../services/desktop/terminals';
import type { ApplicationEvents } from '../core/application-events';
import type { ExecutionNetwork } from '../core/task-contracts';
import type { ClientCommands } from '../core/tools/client-commands';
import type { Store } from '../services/storage/store';
import type { NetworkProfiles } from '../services/network/network-profiles';
import type { Connectors } from '../services/accounts/connectors';
import type { Bots } from '../services/channels/bots';
import type { Channels } from '../services/channels/channels';
import type { Feishu } from '../services/channels/feishu';
import type { McpAuth } from '../modules/plugins/mcp-auth';
import type { Worktrees } from '../modules/projects/worktrees';
import type { GitRepositories } from '../modules/projects/git-repositories';

import type { SecretCodec } from '../services/storage/store';
import type { ComputerAdapter } from '../core/tools/extensions';
import type { ApplicationHost } from './host';
import type { ApplicationCommands } from './commands';

export interface ExecutionEnvironment {
  dataDir: string;
  bundleDir: string;
  emit: (event: AppEvent) => void;
  host: ApplicationHost;
  createSecretCodec(): SecretCodec;
  modelTransport: NonNullable<ExecutionNetwork['transport']>;
  networkProbe?: (
    id: string,
    network?: import('../../src/shared/provider-network').ProviderNetwork,
  ) => Promise<typeof fetch>;
  computer?: ComputerAdapter;
  pendingImports?: Map<string, ProviderInput>;
}

declare module 'cordis' {
  interface Context {
    tzEnvironment: ExecutionEnvironment;
    tzPower: PowerSettings;
    tzUpdates: Updates;
    tzAccounts: Accounts;
    tzAccountBrowser: AccountBrowserHost;
    tzProviderImports: Map<string, ProviderInput>;
    tzClient: ApplicationCommands;
    tzCommands: ClientCommands;
    tzStore: Store;
    tzTasks: TaskService;
    tzEvents: ApplicationEvents;
    tzModelNetwork: ExecutionNetwork;
    tzKnowledge: DomainServices['knowledge'];
    tzContent: DomainServices['content'];
    tzCanvases: DomainServices['canvases'];
    tzCanvasWorkflows: DomainServices['canvasWorkflows'];
    tzArtifacts: DomainServices['artifacts'];
    tzAttachments: DomainServices['attachments'];
    tzAutomations: Automations;
    tzSessions: SessionLifecycle;
    tzApprovals: ApprovalQueue;
    tzTerminals: Terminals;
    tzMemories: DomainServices['memories'];
    tzCheckpoints: DomainServices['checkpoints'];
    tzNetworks: NetworkProfiles;
    tzConnectors: Connectors;
    tzBots: Bots;
    tzChannels: Channels;
    tzFeishu: Feishu;
    tzMcpAuth: McpAuth;
    tzProjectTools: {
      worktrees: Worktrees;
      repositories: GitRepositories;
      activity: { count: number };
    };
  }
}
