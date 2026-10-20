import type { DocumentHost } from '../modules/content/document-host';

/** Native UI and lifecycle operations supplied by the host, never by the executor. */
export interface ApplicationHost {
  version: string;
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
