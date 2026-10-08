import { createContext } from 'react';
export const WorkspaceFileContext = createContext<{
  root: string;
  file?: string;
  open(path: string, line: number): void;
} | null>(null);
