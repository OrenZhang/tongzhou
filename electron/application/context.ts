import './execution-context';
import type { BrowserWindow } from 'electron';
import type { AppEvent, ProviderInput } from '../../src/shared/types';
import type { Updates } from '../services/desktop/updates';
import type { PowerSettings } from '../services/desktop/power';
import type { Accounts } from '../services/accounts/accounts';
import type { AccountBrowser } from '../services/accounts/account-browser';
import type { DesktopComputer } from '../services/desktop/computer';
import type { ComputerPermissions } from '../services/desktop/computer-permissions';
import type { ComputerPermissionPanel } from '../services/desktop/computer-permission-panel';

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
    tzUpdates: Updates;
    tzPower: PowerSettings;
    tzAccounts: Accounts;
    tzAccountBrowser: AccountBrowser;
  }
}
