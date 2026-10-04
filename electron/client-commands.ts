import { z } from 'zod';
import type { ToolScope } from './extensions';
import type { ClientCatalog, ClientMethod } from '../src/shared/client-catalog';

export type ClientOperation = {
  module: string;
  description: string;
  access: 'query' | 'change' | 'manual';
  args: z.ZodType<unknown[]>;
  reason?: string;
  view?: string;
  guard?: (args: unknown[], sessionId: string) => void;
};

/** Declare once beside the business handler. IPC, discovery and chat share this contract. */
export function operation(
  module: string,
  access: 'query' | 'change',
  description: string,
  args: [] | [z.ZodType, ...z.ZodType[]] = [],
  options: Pick<ClientOperation, 'guard'> = {},
): ClientOperation {
  return {
    module,
    access,
    description,
    args: args.length ? z.tuple(args as [z.ZodType, ...z.ZodType[]]) : z.tuple([]),
    ...options,
  };
}
export function manual(
  module: string,
  description: string,
  view: string,
  reason: string,
  args: [] | [z.ZodType, ...z.ZodType[]] = [],
): ClientOperation {
  return {
    module,
    access: 'manual',
    description,
    view,
    reason,
    args: args.length ? z.tuple(args as [z.ZodType, ...z.ZodType[]]) : z.tuple([]),
  };
}

const credentialKey =
  /^(secret|oauthClientSecret|password|cookies?|authorization|access_?token|refresh_?token|signingSecret|webhook|clientSecret|api_?key)$/i;
function containsCredential(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.entries(value).some(
      ([key, child]) => (credentialKey.test(key) && !!child) || containsCredential(child),
    )
  );
}

export class ClientCommands {
  private handlers = new Map<
    string,
    { operation: ClientOperation; handler: (...args: any[]) => unknown }
  >();

  register(name: string, operation: ClientOperation, handler: (...args: any[]) => unknown) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || this.handlers.has(name))
      throw new Error('重复或无效的客户端操作：' + name);
    if (
      !operation.module ||
      !operation.description ||
      (operation.access === 'manual' && (!operation.reason || !operation.view))
    )
      throw new Error('客户端操作缺少模块、说明或手动入口：' + name);
    this.handlers.set(name, { operation, handler });
  }

  describe(filter: { module?: string; method?: string } = {}): ClientCatalog {
    const methods: ClientMethod[] = [...this.handlers]
      .filter(
        ([name, { operation: op }]) =>
          (!filter.module || op.module === filter.module) &&
          (!filter.method || name === filter.method),
      )
      .map(([name, { operation: op }]) => ({
        name,
        module: op.module,
        description: op.description,
        access: op.access,
        reason: op.reason,
        view: op.view,
        arguments: z.toJSONSchema(op.args, { unrepresentable: 'any' }),
      }));
    return {
      modules: [...new Set(methods.map((m) => m.module))],
      methods,
      read: methods.filter((m) => m.access === 'query').map((m) => m.name),
      change: methods.filter((m) => m.access === 'change').map((m) => m.name),
      notes:
        '先查询能力目录和参数结构，再用 snapshot 查询真实 ID。args 为位置参数数组；save* 使用完整配置对象，凭据只能在界面输入。修改遵循当前会话权限。manual 操作请引导用户到 view 对应页面，不得代替用户审批。发送通知须有用户指定的渠道和内容。',
    };
  }

  attach(scope: ToolScope, readOnly: boolean, enabled: () => boolean, sessionId: string) {
    scope.add(
      {
        name: 'client_catalog',
        description:
          '发现同舟所有模块的功能。无参数列出摘要；用 module 筛选模块，用 method 读取某操作的完整位置参数 JSON Schema。新模块注册后自动可见；manual 表示需要用户在对应页面操作。',
        parameters: {
          type: 'object',
          properties: { module: { type: 'string' }, method: { type: 'string' } },
          additionalProperties: false,
        },
      },
      '查询客户端能力目录',
      async (input) => {
        const filter = z
          .object({ module: z.string().optional(), method: z.string().optional() })
          .strict()
          .parse(input);
        const catalog = this.describe(filter);
        return {
          text: JSON.stringify({
            ...catalog,
            readOnly,
            methods: catalog.methods.map(({ arguments: args, ...m }) => ({
              ...m,
              available: m.access === 'query' || (m.access === 'change' && !readOnly),
              ...(filter.method ? { arguments: args } : {}),
            })),
          }),
        };
      },
      false,
      enabled,
    );

    for (const [name, access, approval] of [
      ['client_query', 'query', false],
      ['client_change', 'change', true],
    ] as const) {
      if (readOnly && approval) continue;
      scope.add(
        {
          name,
          description:
            (approval ? '执行' : '查询') +
            '同舟模块功能。先调用 client_catalog 发现操作及参数；method 是注册名。推荐 argsJson：将完整位置参数数组编码为 JSON 字符串，例如 [{"name":"demo"}]。也可用 args 数组；二选一。不得传入凭据。',
          parameters: {
            type: 'object',
            properties: {
              method: { type: 'string' },
              args: { type: 'array', items: {} },
              argsJson: {
                type: 'string',
                description:
                  'JSON 编码的完整位置参数数组；支持对象、布尔等原始类型。与 args 二选一。',
              },
            },
            required: ['method'],
            additionalProperties: false,
          },
        },
        approval ? '执行同舟操作' : '查询同舟',
        async (input) => {
          const call = z
            .object({
              method: z.string(),
              args: z.array(z.unknown()).optional(),
              argsJson: z.string().max(1000000).optional(),
            })
            .strict()
            .refine(
              (v) => (v.args !== undefined) !== (v.argsJson !== undefined),
              'args 与 argsJson 必须且只能提供一种',
            )
            .parse(input);
          let args = call.args;
          if (call.argsJson !== undefined) {
            try {
              args = z.array(z.unknown()).parse(JSON.parse(call.argsJson));
            } catch {
              throw new Error('argsJson 必须是有效的 JSON 数组，例如 [{"name":"demo"}]');
            }
          }
          const entry = this.handlers.get(call.method);
          if (!entry || entry.operation.access !== access)
            throw new Error('此操作不可通过当前工具执行，请查询 client_catalog');
          if (containsCredential(args))
            throw new Error('请通过安全配置界面设置凭据，聊天工具不接收凭据');
          const parsed = entry.operation.args.safeParse(args);
          if (!parsed.success)
            throw new Error(
              '参数不符合操作定义：' +
                parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
            );
          entry.operation.guard?.(parsed.data, sessionId);
          const value = await entry.handler(...parsed.data);
          return {
            text: JSON.stringify(value ?? { success: true }, function (key, child) {
              // Status discovery must never relay device codes, login URLs or credential fields.
              if (
                credentialKey.test(key) ||
                /^(userCode|device_code|deviceCode)$/i.test(key) ||
                (key === 'url' && this && typeof this === 'object' && 'phase' in this)
              )
                return undefined;
              return child;
            }),
          };
        },
        approval,
        enabled,
      );
    }
  }
}
