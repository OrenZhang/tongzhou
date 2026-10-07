import type { ProviderNetwork } from '../../../src/shared/provider-network';
import { normalizeProxyUrl } from '../../../src/shared/provider-network';

export const proxyEnvironmentKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];
/** Never mutate the app environment: only the selected account's engine receives this copy. */
export function accountEnvironment(
  base: NodeJS.ProcessEnv,
  network?: ProviderNetwork,
): NodeJS.ProcessEnv {
  if (network?.mode === 'managed') throw new Error('内置网络必须启动后再连接');
  const env = { ...base };
  if (!network || network.mode === 'inherit') return env;
  for (const key of Object.keys(env))
    if (proxyEnvironmentKeys.some((p) => p.toLowerCase() === key.toLowerCase())) delete env[key];
  const bypass = network.mode === 'direct' ? '*' : 'localhost,127.0.0.1,::1';
  env.NO_PROXY = bypass;
  env.no_proxy = bypass;
  if (network.mode === 'proxy') {
    const url = normalizeProxyUrl(network.proxyUrl || '');
    for (const key of proxyEnvironmentKeys.filter((k) => !/no_proxy/i.test(k))) env[key] = url;
  }
  return env;
}
export function accountProxyConfig(network?: ProviderNetwork) {
  if (network?.mode === 'managed') throw new Error('内置网络必须启动后再连接');
  if (!network || network.mode === 'inherit') return { mode: 'system' as const };
  if (network.mode === 'direct') return { mode: 'direct' as const };
  return {
    mode: 'fixed_servers' as const,
    proxyRules: normalizeProxyUrl(network.proxyUrl || ''),
    proxyBypassRules: 'localhost,127.0.0.1,[::1]',
  };
}
