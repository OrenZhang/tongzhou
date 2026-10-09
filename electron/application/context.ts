import type { BrowserWindow } from 'electron';
import type { AppEvent, ProviderInput } from '../../src/shared/types';
import type { Runtime } from '../core/runtime/runtime';
import type { ClientCommands } from '../core/tools/client-commands';
import type { Store } from '../services/storage/store';
import type { Updates } from '../services/desktop/updates';
import type { NetworkProfiles } from '../services/network/network-profiles';
import type { Accounts } from '../services/accounts/accounts';
import type { AccountBrowser } from '../services/accounts/account-browser';
import type { Connectors } from '../services/accounts/connectors';
import type { BrowserProfiles } from '../services/browser/browser-profiles';
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
    tzRuntime: Runtime;
    tzExecution: Pick<
      Runtime,
      'start' | 'snapshot' | 'changed' | 'processMemory' | 'invalidateNative'
    >;
    tzKnowledge: Runtime['knowledge'];
    tzContent: Runtime['content'];
    tzArtifacts: Runtime['artifacts'];
    tzAttachments: Runtime['attachments'];
    tzAutomations: Runtime['automations'];
    tzSessions: Runtime['sessions'];
    tzApprovals: Runtime['approvalQueue'];
    tzTerminals: Runtime['terminals'];
    tzMemories: Runtime['memories'];
    tzCheckpoints: Runtime['checkpoints'];
    tzUpdates: Updates;
    tzNetworks: NetworkProfiles;
    tzAccounts: Accounts;
    tzAccountBrowser: AccountBrowser;
    tzConnectors: Connectors;
    tzBrowserProfiles: BrowserProfiles;
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
