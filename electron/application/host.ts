import type { ComputerControl } from '../services/desktop/computer';
import type { ComputerPermissionGuide } from '../../src/shared/types';
import type { DocumentHost } from '../modules/content/document-host';

/** Native UI and lifecycle operations supplied by the host, never by the executor. */
export interface ApplicationHost {
  version: string;
  computer?: {
    controller: ComputerControl;
    guide(): Promise<ComputerPermissionGuide | null>;
    openSettings(permission: 'accessibility' | 'screen'): Promise<void>;
    reveal(): Promise<void>;
    diagnostic(): Promise<{ ok: boolean; time: number; detail: string }>;
  };
  setTheme?(theme: 'system' | 'light' | 'dark'): void | Promise<void>;
  dialogs: {
    showOpenDialog(options: {
      title?: string;
      defaultPath?: string;
      properties?: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[];
      filters?: { name: string; extensions: string[] }[];
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog(options: {
      title?: string;
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<{ canceled: boolean; filePath?: string }>;
  };
  documents: DocumentHost;
  writeClipboard(text: string): void | Promise<void>;
  restart(): void | Promise<void>;
}
