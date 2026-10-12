import type { Provider } from './types';

export const apiProtocols = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const;
export type ApiProtocol = (typeof apiProtocols)[number];
export function modelProvider(provider: Provider, model: string): Provider {
  const protocol =
    provider.modelProtocols && Object.hasOwn(provider.modelProtocols, model)
      ? provider.modelProtocols[model]
      : undefined;
  return protocol &&
    apiProtocols.includes(protocol) &&
    apiProtocols.includes(provider.protocol as ApiProtocol)
    ? { ...provider, protocol }
    : provider;
}
