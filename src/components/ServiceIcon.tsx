import {
  Figma,
  Github,
  Gitlab,
  BookOpen,
  CircleDot,
  Sparkles,
  Globe2,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import type { Provider } from '../shared/types';
const icons: Record<string, LucideIcon> = {
  github: Github,
  gitlab: Gitlab,
  figma: Figma,
  notion: BookOpen,
  linear: CircleDot,
  openai: Sparkles,
  codex: Sparkles,
  anthropic: Sparkles,
  gemini: Sparkles,
  local: Terminal,
};
export function providerService(provider: Pick<Provider, 'protocol' | 'baseUrl' | 'auth'>): string {
  if (['codex', 'kimi', 'minimax'].includes(provider.protocol)) return provider.protocol;
  let host = '';
  try {
    host = new URL(provider.baseUrl).hostname;
  } catch {
    /* Custom provider without a URL. */
  }
  const domains: Record<string, string[]> = {
    openai: ['openai.com'],
    deepseek: ['deepseek.com'],
    qwen: ['aliyuncs.com'],
    kimi: ['moonshot.cn', 'moonshot.ai', 'kimi.com'],
    minimax: ['minimax.cn', 'minimax.io'],
    glm: ['bigmodel.cn'],
    anthropic: ['anthropic.com'],
    gemini: ['googleapis.com'],
    opencode: ['opencode.ai'],
  };
  for (const [service, names] of Object.entries(domains)) {
    if (names.some((domain) => host === domain || host.endsWith('.' + domain))) return service;
  }
  return provider.auth === 'none' ? 'local' : 'custom';
}
export function ServiceIcon({ service, size = 20 }: { service: string; size?: number }) {
  const Icon = icons[service] ?? Globe2;
  return (
    <span className="service-icon" data-service={service} aria-hidden="true">
      <Icon size={size} />
    </span>
  );
}
