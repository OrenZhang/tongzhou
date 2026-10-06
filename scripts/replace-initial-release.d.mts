export const initialAssetNames: string[];
export function replaceInitialRelease(options: {
  version: string;
  repo: string;
  sha: string;
  notes: string;
  assets: { name: string; size: number; sha256: string }[];
  api(method: string, endpoint: string, body?: Record<string, unknown>): any;
  upload(): void;
}): void;
