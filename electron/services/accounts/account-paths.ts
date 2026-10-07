import path from 'node:path';
export function engineHome(dataDir: string, engine: string, providerId: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(providerId)) throw new Error('无效账号标识');
  if (engine === 'codex' && providerId === 'openai-codex') return path.join(dataDir, 'codex');
  if (providerId === `${engine}-account`) return path.join(dataDir, 'engines', engine);
  return path.join(dataDir, 'accounts', providerId, engine);
}
