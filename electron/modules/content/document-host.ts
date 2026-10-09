/** Host operations needed by documents; domain handlers can run without Electron. */
export interface DocumentHost {
  chooseFiles(title: string): Promise<string[]>;
  readImport(file: string): Promise<Buffer>;
  saveCopy(bytes: Buffer, title: string, defaultPath: string): Promise<string | null>;
  writeTo(
    file: string,
    bytes: Buffer,
    expectedSha256?: string,
  ): Promise<{
    path: string;
    persisted: boolean;
    bytes: number;
    sha256: string;
  }>;
  openPath(file: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}
