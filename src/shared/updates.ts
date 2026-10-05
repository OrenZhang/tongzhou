export interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error'
    | 'unsupported';
  currentVersion: string;
  version?: string;
  progress?: number;
  message?: string;
  automaticInstall: boolean;
}
