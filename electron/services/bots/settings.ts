import { idSchema } from '../storage/validation';
import { z } from 'zod';
import type { BotSettings } from '../../../src/shared/types';
import type { Store } from '../storage/store';

export const botSettingsSchema = z.object({
  mode: z.enum(['workbench', 'chat']),
  defaultProjectId: idSchema.optional(),
  providerId: z.string().min(1),
  model: z.string().trim().min(1).max(200),
  permission: z.enum(['read-only', 'ask', 'full-access']),
});
export function botSettings(store: Store): BotSettings {
  const saved = store.list<BotSettings>('botSettings')[0];
  const provider = store.providers().find((p) => p.enabled !== false && p.models.length);
  return {
    providerId: saved?.providerId ?? provider?.id ?? '',
    model: saved?.model ?? provider?.models[0] ?? '',
    permission: saved?.permission ?? 'full-access',
    mode: saved?.mode ?? 'workbench',
    ...(saved?.defaultProjectId ? { defaultProjectId: saved.defaultProjectId } : {}),
  };
}
