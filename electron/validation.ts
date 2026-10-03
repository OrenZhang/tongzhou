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
    protocol: z.enum([
      'openai-chat',
      'openai-responses',
      'anthropic',
      'gemini',
      'codex',
      'kimi',
      'minimax',
    ]),
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
    auth: z.enum(['api-key', 'bearer', 'none', 'chatgpt', 'native']),
    models: z.array(z.string().trim().min(1).max(200)).max(200),
    modelLabels: z.record(z.string().max(200), z.string().max(200)).optional(),
    maxOutputTokens: z.number().int().min(256).max(131072),
    contextChars: z.union([z.literal(0), z.number().int().min(4000).max(1000000)]),
    secret: z.string().max(16000).optional(),
    clearSecret: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.protocol === 'codex' && p.auth !== 'chatgpt')
      ctx.addIssue({ code: 'custom', message: 'Codex 连接使用 ChatGPT 登录', path: ['auth'] });
    const native = p.protocol === 'kimi' || p.protocol === 'minimax';
    if (native && (p.auth !== 'native' || p.baseUrl || p.secret))
      ctx.addIssue({
        code: 'custom',
        message: '原生账号连接由官方引擎管理认证，无需密钥或地址',
        path: ['auth'],
      });
    if (
      !native &&
      p.protocol !== 'codex' &&
      (!p.baseUrl || p.auth === 'chatgpt' || p.auth === 'native')
    )
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
  pluginIds: z.array(id).max(20).optional(),
  skillIds: z.array(id).max(20).optional(),
  computerEnabled: z.boolean().optional(),
});
export const pluginSchema = z
  .object({
    authMode: z.enum(['headers', 'oauth']).optional(),
    oauthClientId: z.string().trim().max(300).optional(),
    oauthIssuer: z.string().max(2000).optional(),
    oauthClientSecret: z.string().max(10000).optional(),
    clearOAuthClientSecret: z.boolean().optional(),
    id,
    name: z.string().trim().min(1).max(100),
    transport: z.enum(['stdio', 'http']),
    command: z.string().max(2048),
    args: z.array(z.string().max(4096)).max(100),
    url: z.string().max(2048),
    enabled: z.boolean(),
    readOnlyTools: z.array(z.string().min(1).max(200)).max(200),
    secret: z.string().max(20000).optional(),
    clearSecret: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.authMode === 'oauth' && p.transport !== 'http')
      ctx.addIssue({ code: 'custom', message: 'OAuth 仅适用于远程 HTTP 插件' });
    if (p.oauthClientId && (!p.oauthIssuer || !/^https:\/\//.test(p.oauthIssuer)))
      ctx.addIssue({ code: 'custom', message: '预注册 Client ID 需要对应的 HTTPS 授权服务地址' });
    if (p.transport === 'stdio' && !p.command.trim())
      ctx.addIssue({ code: 'custom', message: '请输入 MCP 启动命令' });
    if (p.transport === 'http') {
      try {
        const u = new URL(p.url);
        if (
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          !(
            u.protocol === 'https:' ||
            (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
          )
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'MCP 地址必须为 HTTPS 或本机 HTTP，不能包含凭据或查询参数',
        });
      }
    }
    if (p.secret) {
      try {
        const s = JSON.parse(p.secret);
        if (
          !s ||
          Array.isArray(s) ||
          typeof s !== 'object' ||
          Object.entries(s).some(
            ([k, v]) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) || typeof v !== 'string',
          )
        )
          throw new Error();
      } catch {
        ctx.addIssue({ code: 'custom', message: '环境变量 / 请求头必须为字符串值的 JSON 对象' });
      }
    }
  });
export const runSchema = z.object({
  sessionId: id,
  prompt: z.string().trim().min(1).max(100000),
  providerId: id,
  model: z.string().trim().min(1).max(200),
  agentId: id.or(z.literal('')).default(''),
});
export const idSchema = id;
export function redact(value: string, secrets: string[] = []) {
  let out = value
    .replace(/(Bearer\s+)[^\s"<>]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED]');
  for (const secret of secrets) if (secret) out = out.split(secret).join('[REDACTED]');
  return out;
}
