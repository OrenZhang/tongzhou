import './execution-context';
import type { BrowserWindow } from 'electron';
import type { AppEvent, ProviderInput } from '../../src/shared/types';
import type { DesktopComputer } from '../services/desktop/electron-computer';
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
  }
}
