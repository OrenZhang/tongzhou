import { z } from 'zod';
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const providerSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(100),
    protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'codex']),
    baseUrl: z
      .string()
      .max(2048)
      .refine((value) => {
        if (!value) return true;
        try {
          const u = new URL(value);
          return (
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash &&
            (u.protocol === 'https:' ||
              (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
          );
        } catch {
          return false;
        }
      }, '服务地址必须是 HTTPS，或本机 HTTP 地址，且不包含密钥、查询参数或片段'),
    auth: z.enum(['api-key', 'bearer', 'none', 'chatgpt']),
    models: z.array(z.string().trim().min(1).max(200)).max(200),
    maxOutputTokens: z.number().int().min(256).max(131072),
    contextChars: z.number().int().min(4000).max(1000000),
    secret: z.string().max(16000).optional(),
    clearSecret: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.protocol === 'codex' && p.auth !== 'chatgpt')
      ctx.addIssue({ code: 'custom', message: 'Codex 连接使用 ChatGPT 登录', path: ['auth'] });
    if (p.protocol !== 'codex' && (!p.baseUrl || p.auth === 'chatgpt'))
      ctx.addIssue({
        code: 'custom',
        message: 'API 连接需要服务地址及匹配的认证方式',
        path: ['baseUrl'],
      });
  });
export const agentSchema = z.object({
  id,
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  instructions: z.string().max(16000),
  providerId: z.string().max(120),
  model: z.string().max(200),
  permission: z.enum(['read-only', 'ask']),
  maxSteps: z.number().int().min(1).max(40),
});
export const runSchema = z.object({
  sessionId: id,
  prompt: z.string().trim().min(1).max(100000),
  providerId: id,
  model: z.string().trim().min(1).max(200),
  agentId: id,
});
export const idSchema = id;
export function redact(value: string, secrets: string[] = []) {
  let out = value
    .replace(/(Bearer\s+)[^\s"<>]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED]');
  for (const secret of secrets) if (secret) out = out.split(secret).join('[REDACTED]');
  return out;
}
