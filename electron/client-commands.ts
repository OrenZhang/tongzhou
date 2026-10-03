import type { ToolScope } from './extensions';

/** UI and chat invoke the same validated business handlers, never arbitrary IPC. */
export class ClientCommands {
  private handlers = new Map<string, (...args: any[]) => unknown>();
  private readonly readable = new Set([
    'snapshot',
    'messages',
    'runEvents',
    'computerStatus',
    'listFiles',
    'readFile',
    'diff',
    'clientMethods',
  ]);
  private readonly writable = new Set([
    'saveAgent',
    'deleteAgent',
    'createSession',
    'updateSession',
    'deleteSession',
    'savePlugin',
    'deletePlugin',
    'testPlugin',
    'saveSkill',
    'deleteSkill',
    'setCapability',
    'saveProvider',
    'deleteProvider',
    'models',
    'saveChannel',
    'deleteChannel',
    'sendChannel',
    'saveNotificationRule',
    'deleteNotificationRule',
    'saveConnector',
    'deleteConnector',
    'testConnector',
    'openBrowserProfile',
    'clearBrowserProfile',
    'initializeAgent',
    'branchSession',
    'installBuiltinPlugin',
    'openModule',
  ]);
  register(name: string, handler: (...args: any[]) => unknown) {
    if (this.readable.has(name) || this.writable.has(name)) this.handlers.set(name, handler);
  }
  describe() {
    return {
      read: [...this.readable].filter((name) => this.handlers.has(name)),
      change: [...this.writable].filter((name) => this.handlers.has(name)),
      examples: {
        snapshot: [],
        messages: ['sessionId'],
        setCapability: ['computer', true],
        updateSession: ['sessionId', { title: '新标题' }],
        saveAgent: [
          {
            id: 'new-agent-id',
            name: '我的角色',
            description: '',
            instructions: '按用户要求工作',
            providerId: '',
            model: '',
            permission: 'ask',
            maxSteps: 20,
          },
        ],
        sendChannel: ['channelId', '用户要求发送的准确文本', 'sessionId'],
        saveNotificationRule: [
          {
            id: 'rule-id',
            channelId: 'channelId',
            sessionId: 'sessionId',
            enabled: true,
            once: true,
            events: ['completed'],
            template: '{title} {status}',
          },
        ],
        openModule: ['providers'],
        initializeAgent: ['projectId'],
        branchSession: ['sessionId', 'messageId'],
      },
      notes:
        '先用 snapshot 查询真实 ID。save* 使用 snapshot 中完整对象及修改字段；delete* 传 ID。账号凭据只在 UI 输入。规则保存后适用其 scope；主动发送必须有用户要求的收件渠道和内容。',
    };
  }
  attach(scope: ToolScope, readOnly: boolean, enabled: () => boolean, sessionId: string) {
    for (const [name, commands, approval] of [
      ['client_query', this.readable, false],
      ['client_change', this.writable, true],
    ] as const) {
      if (readOnly && approval) continue;
      scope.add(
        {
          name,
          description: approval
            ? '修改同舟客户端配置。args 是该方法的参数数组。会话和 Agent 可为空。不得传入任何密钥。saveAgent 接收完整角色对象；setCapability 接收能力名称及布尔值；updateSession 接收会话 ID 及补丁。先查询真实 ID 再修改。'
            : '查询同舟当前真实状态。snapshot 返回连接、Agent、插件、Skills、会话和运行状态；messages / runEvents 接收会话 ID；computerStatus 无参数。args 为参数数组。',
          parameters: {
            type: 'object',
            properties: {
              method: { type: 'string', enum: [...commands].filter((m) => this.handlers.has(m)) },
              args: { type: 'array', items: {} },
            },
            required: ['method', 'args'],
            additionalProperties: false,
          },
        },
        approval ? '修改同舟设置' : '查询同舟',
        async (input) => {
          if (!enabled()) throw new Error('客户端管理已停用');
          if (!commands.has(input.method) || !Array.isArray(input.args))
            throw new Error('不支持的客户端操作');
          if (input.method === 'deleteSession' && input.args[0] === sessionId)
            throw new Error('请通过会话菜单删除当前正在运行的会话，以完成任务收尾');
          const containsCredential = (value: any): boolean =>
            value &&
            typeof value === 'object' &&
            Object.entries(value).some(
              ([key, child]) =>
                (/^(secret|password|cookies?|authorization|accessToken|refreshToken|signingSecret|webhook)$/i.test(
                  key,
                ) &&
                  !!child) ||
                containsCredential(child),
            );
          if (containsCredential(input.args))
            throw new Error('请通过安全配置界面设置凭据，聊天工具不接收凭据');
          const handler = this.handlers.get(input.method);
          if (!handler) throw new Error('此客户端操作尚未提供');
          const value = await handler(...input.args);
          return { text: JSON.stringify(value ?? { success: true }) };
        },
        approval,
      );
    }
  }
}
