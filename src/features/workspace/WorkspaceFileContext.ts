import { createContext } from 'react';
export const WorkspaceFileContext = createContext<{
  root: string;
  open(path: string, line: number): void;
} | null>(null);
