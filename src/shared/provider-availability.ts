import type { Provider } from './types';

export interface AccountAvailability {
  connected: boolean;
  pending: boolean;
  error: boolean;
}

/** Configuration readiness, not a claim that the remote service is reachable. */
export function providerUnavailableReason(
  provider: Provider,
  account?: AccountAvailability,
): string {
  if (provider.enabled === false) return '已停用';
  if (['codex', 'kimi', 'minimax'].includes(provider.protocol)) {
    if (!account) return '正在检查授权';
    if (!account.connected)
      return account.pending ? '等待授权完成' : account.error ? '授权状态检查失败' : '尚未授权';
  } else {
    if (!provider.baseUrl.trim()) return '尚未配置服务地址';
    if (provider.auth !== 'none' && !provider.hasSecret) return '尚未配置密钥';
  }
  // An untouched local-service preset is not a configured connection. Explicitly
  // enabled services may discover their models from the picker after selection.
  if (
    provider.auth === 'none' &&
    provider.enabled !== true &&
    !provider.models.some((model) => model.trim())
  )
    return '尚未配置模型';
  return '';
}
