import { z } from 'zod';
import { idSchema } from '../storage/validation';
import { weixinApiUrl } from './weixin/api';
import type { Store } from '../storage/store';
import type { BotConfig } from '../../../src/shared/types';

export const botSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['feishu', 'wecom', 'dingtalk', 'weixin']),
  appId: z.string().trim().min(1).max(200),
  apiBaseUrl: z
    .string()
    .url()
    .refine((value) => {
      try {
        weixinApiUrl(value);
        return true;
      } catch {
        return false;
      }
    }, '微信服务地址无效')
    .optional(),
  secret: z.string().max(4000).optional(),
  domain: z.enum(['feishu', 'lark']).optional(),
  allowedSenders: z.array(z.string().trim().min(1).max(200)).max(100),
  allowedChats: z.array(z.string().trim().min(1).max(200)).max(100),
});
export function publicBot(store: Store, bot: BotConfig): BotConfig {
  const { secret: _secret, ...config } = botSchema.parse(bot);
  return {
    ...config,
    status: bot.status,
    error: bot.error,
    lastMessageAt: bot.lastMessageAt,
    hasSecret: store.hasSecret('bot_' + bot.id),
  };
}
