import { dialog, shell } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { DocumentHost } from '../../modules/content/document-host';
import { writeLocalFile } from '../storage/file-transfer';

export const desktopDocumentHost: DocumentHost = {
  async chooseFiles(title) {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  },
  async readImport(file) {
    if ((await stat(file)).size > 25 * 1024 * 1024) throw new Error('超过 25 MB');
    const bytes = await readFile(file);
    if (bytes.length > 25 * 1024 * 1024) throw new Error('超过 25 MB');
    return bytes;
  },
  async saveCopy(bytes, title, defaultPath) {
    const result = await dialog.showSaveDialog({ title, defaultPath });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, bytes);
    return result.filePath;
  },
  writeTo: writeLocalFile,
  async openPath(file) {
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  },
  openExternal: (url) => shell.openExternal(url),
};
