export interface ProviderNetwork {
  mode: 'inherit' | 'direct' | 'proxy' | 'managed';
  proxyUrl?: string;
  profileId?: string;
  transport?: 'http' | 'auto';
}
export function normalizeProxyUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    !u.hostname ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/'
  )
    throw new Error(
      '请填写 HTTP / HTTPS 代理地址，如 http://127.0.0.1:7890，不包含账号密码、路径或参数',
    );
  return u.origin;
}
export function networkKey(value?: ProviderNetwork): string {
  if (value?.transport === 'http') return networkKey({ ...value, transport: undefined }) + ':http';
  if (value?.mode === 'managed') return 'managed:' + value.profileId;
  return value?.mode === 'proxy'
    ? 'proxy:' + normalizeProxyUrl(value.proxyUrl || '')
    : value?.mode || 'inherit';
}
