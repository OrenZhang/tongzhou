export function resetInitialRelease(options: {
  version: string;
  repo?: string;
  sha?: string;
  api: (method: 'GET' | 'DELETE', endpoint: string, missing?: boolean) => any;
}): void;
