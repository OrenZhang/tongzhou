import { t } from './i18n';

const defaults: Record<string, string> = {
  local: '本地模型',
  'kimi-account': 'Kimi · 账号授权',
  'minimax-account': 'MiniMax · 账号授权',
};

/** Only localize unchanged built-in names; custom connection names belong to the user. */
export function providerLabel(provider: { id: string; name: string }): string {
  return defaults[provider.id] === provider.name ? t(provider.name) : provider.name;
}
