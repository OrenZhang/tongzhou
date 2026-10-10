import type { BrowserWindow } from 'electron';
import type { AppEvent, ProviderInput } from '../../src/shared/types';
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
import type { Updates } from '../services/desktop/updates';
import type { NetworkProfiles } from '../services/network/network-profiles';
import type { Accounts } from '../services/accounts/accounts';
import type { AccountBrowser } from '../services/accounts/account-browser';
import type { Connectors } from '../services/accounts/connectors';
import type { Bots } from '../services/channels/bots';
import type { Channels } from '../services/channels/channels';
import type { Feishu } from '../services/channels/feishu';
import type { McpAuth } from '../modules/plugins/mcp-auth';
import type { Worktrees } from '../modules/projects/worktrees';
import type { GitRepositories } from '../modules/projects/git-repositories';
import type { DesktopComputer } from '../services/desktop/computer';
import type { ComputerPermissions } from '../services/desktop/computer-permissions';
import type { ComputerPermissionPanel } from '../services/desktop/computer-permission-panel';
import type { ClientIpc } from './client-ipc';

export interface DesktopEnvironment {
  dataDir: string;
  bundleDir: string;
  emit: (event: AppEvent) => void;
  getWindow: () => BrowserWindow | undefined;
  trusted: (url: string) => boolean;
  computer: DesktopComputer;
  computerPermissions: ComputerPermissions;
  computerPermissionPanel: ComputerPermissionPanel;
  pendingImports: Map<string, ProviderInput>;
}

declare module 'cordis' {
  interface Context {
    tzDesktop: DesktopEnvironment;
    tzCommands: ClientCommands;
    tzIpc: ClientIpc;
    tzStore: Store;
    tzTasks: TaskService;
    tzEvents: ApplicationEvents;
    tzModelNetwork: ExecutionNetwork;
    tzKnowledge: DomainServices['knowledge'];
    tzContent: DomainServices['content'];
    tzArtifacts: DomainServices['artifacts'];
    tzAttachments: DomainServices['attachments'];
    tzAutomations: Automations;
    tzSessions: SessionLifecycle;
    tzApprovals: ApprovalQueue;
    tzTerminals: Terminals;
    tzMemories: DomainServices['memories'];
    tzCheckpoints: DomainServices['checkpoints'];
    tzUpdates: Updates;
    tzNetworks: NetworkProfiles;
    tzAccounts: Accounts;
    tzAccountBrowser: AccountBrowser;
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
