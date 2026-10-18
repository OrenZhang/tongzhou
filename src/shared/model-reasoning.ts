import { localize as localized } from './i18n';
export const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export const reasoningLabels: Record<ReasoningEffort, string> = localized({
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '更高',
  max: '最高',
});
