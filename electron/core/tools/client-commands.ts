import { z } from 'zod';
import type { ToolScope } from './extensions';
import type { ClientCatalog, ClientMethod } from '../../../src/shared/client-catalog';
import type { Store } from '../../services/storage/store';
import type { Session } from '../../../src/shared/types';

export type ClientOperation = {
  module: string;
  description: string;
  access: 'query' | 'change' | 'manual';
  args: z.ZodType<unknown[]>;
  reason?: string;
  view?: string;
  guard?: (args: unknown[], sessionId: string) => void;
  unavailable?: (sessionId: string) => string | undefined;
  chat?: (args: any[], sessionId: string) => unknown;
  confirmation?: 'always' | 'none';
};

export type ClientRegistrar = (
  name: string,
  definition: ClientOperation,
  handler: (...args: any[]) => any,
) => void;

/** Declare once beside the business handler. IPC, discovery and chat share this contract. */
export function operation(
  module: string,
  access: 'query' | 'change',
  description: string,
  args: [] | [z.ZodType, ...z.ZodType[]] = [],
  options: Pick<ClientOperation, 'guard' | 'unavailable' | 'chat' | 'confirmation'> = {},
): ClientOperation {
  return {
    module,
    access,
    description,
    args: args.length ? z.tuple(args as [z.ZodType, ...z.ZodType[]]) : z.tuple([]),
    ...options,
  };
}

/** Workspace management is available in ordinary chats; background jobs keep scoped tools. */
export function workspaceOperation(
  store: Store,
  module: string,
  access: 'query' | 'change',
  description: string,
  args: [] | [z.ZodType, ...z.ZodType[]] = [],
  options: Pick<ClientOperation, 'guard' | 'chat' | 'confirmation'> = {},
): ClientOperation {
  return operation(module, access, description, args, {
    ...options,
    unavailable: (id) => {
      const s = store.get<Session>('session', id);
      return s.automationJob || s.memoryJob || s.parentId || s.knowledgeJob || s.contentContext
        ? '后台或文档任务使用当前范围的专用工具；工作台管理请在普通会话中调用'
        : undefined;
    },
  });
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
    const entry = { operation, handler };
    this.handlers.set(name, entry);
    return () => {
      if (this.handlers.get(name) === entry) this.handlers.delete(name);
    };
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
        confirmation: op.confirmation,
        reason: op.reason,
        view: op.view,
        arguments: z.toJSONSchema(op.args, { unrepresentable: 'any', io: 'input' }),
      }));
    return {
      modules: [...new Set(methods.map((m) => m.module))],
      methods,
      read: methods.filter((m) => m.access === 'query').map((m) => m.name),
      change: methods.filter((m) => m.access === 'change').map((m) => m.name),
      notes:
        '目录描述本轮真实能力，旧会话中的能力判断可能已过期。先查询参数，再查询真实 ID。args 为位置参数数组；save* 使用完整配置对象。普通会话可管理工作台资料与配置。contentWrite 与 content_write 都调用内容库持久化业务；单个 manual 操作不可用不代表整个模块不可用。写入后按返回 ID 读回核验。凭据在安全界面输入；不得代替用户审批。发送通知须有用户指定的渠道和内容。',
    };
  }

  attach(scope: ToolScope, readOnly: boolean, enabled: () => boolean, sessionId: string) {
    scope.add(
      {
        name: 'client_catalog',
        description:
          '发现同舟所有模块的功能与配置。内容保存用 contentWrite，偏好配置用 personalizationState/savePersonalization。无参数列出摘要；module 是模块名（如 Skills），method 是操作名（如 snapshot）。查询操作参数示例：{"method":"snapshot"}。manual 表示需要用户在对应页面操作。',
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
        // A method passed as a module is an unambiguous discovery request, not an execution.
        if (filter.module && !filter.method && this.handlers.has(filter.module)) {
          filter.method = filter.module;
          delete filter.module;
        }
        const matched = this.describe(filter);
        const lookupError =
          matched.methods.length === 0 && (filter.method || filter.module)
            ? '未找到指定操作或模块。下面返回本轮实际注册的能力总览；请使用其中的准确 name 查询参数，不能据此判断模块不可用，也不要猜测操作名。'
            : undefined;
        const catalog = lookupError ? this.describe() : matched;
        return {
          ...(lookupError ? { isError: true } : {}),
          text: JSON.stringify({
            ...catalog,
            ...(lookupError ? { lookupError, requested: filter } : {}),
            readOnly,
            methods: catalog.methods.map(({ arguments: args, ...m }) => {
              const reason =
                this.handlers.get(m.name)!.operation.unavailable?.(sessionId) ??
                (m.access === 'change' && readOnly ? '当前会话为只读模式' : m.reason);
              return {
                ...m,
                available:
                  !reason && (m.access === 'query' || (m.access === 'change' && !readOnly)),
                ...(reason ? { reason } : {}),
                ...(filter.method && !lookupError ? { arguments: args } : {}),
              };
            }),
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
            '同舟模块功能。先调用 client_catalog 发现操作及参数；method 是注册名。推荐 argsJson：将完整位置参数数组编码为 JSON 字符串，例如 [{"name":"demo"}]。也可用 args 数组，不能同时提供。无参数操作可省略两者（例如 {"method":"snapshot"}）。不得传入凭据。',
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
              (v) => v.args === undefined || v.argsJson === undefined,
              'args 与 argsJson 不能同时提供',
            )
            .parse(input);
          let args = call.args ?? [];
          if (call.argsJson !== undefined) {
            try {
              args = z.array(z.unknown()).parse(JSON.parse(call.argsJson));
            } catch {
              throw new Error('argsJson 必须是有效的 JSON 数组，例如 [{"name":"demo"}]');
            }
          }
          const entry = this.handlers.get(call.method);
          if (!entry)
            throw new Error(
              '未注册操作：' +
                call.method +
                '。请调用 client_catalog({}) 获取真实操作名，再按 name 查询参数，不能猜测操作名或判断整个模块不可用',
            );
          if (entry.operation.access !== access)
            throw new Error(
              '此操作不可通过当前工具执行：' +
                call.method +
                '；' +
                (entry.operation.access === 'manual'
                  ? entry.operation.reason
                  : '请使用 client_' + entry.operation.access) +
                '。参数可通过 client_catalog 的 method 查询',
            );
          const unavailable = entry.operation.unavailable?.(sessionId);
          if (unavailable) throw new Error(unavailable);
          if (containsCredential(args))
            throw new Error('请通过安全配置界面设置凭据，聊天工具不接收凭据');
          const parsed = entry.operation.args.safeParse(args);
          if (!parsed.success)
            throw new Error(
              '参数不符合操作定义：' +
                parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
            );
          entry.operation.guard?.(parsed.data, sessionId);
          const value = await (entry.operation.chat
            ? entry.operation.chat(parsed.data, sessionId)
            : entry.handler(...parsed.data));
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
        approval
          ? (input) => {
              const confirmation = this.handlers.get(input?.method)?.operation.confirmation;
              return confirmation === 'always' ? 'always' : confirmation !== 'none';
            }
          : false,
        enabled,
      );
    }
  }
}
