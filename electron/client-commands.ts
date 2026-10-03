import type { ToolScope } from './extensions';

/** UI and chat invoke the same validated business handlers, never arbitrary IPC. */
export class ClientCommands {
  private handlers = new Map<string, (...args: any[]) => unknown>();
  private readonly readable = new Set([
    'snapshot',
    'messages',
    'readMessage',
    'runEvents',
    'computerStatus',
    'listFiles',
    'readFile',
    'diff',
    'listWorktrees',
    'gitRepository',
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
    'createWorktree',
    'removeWorktree',
    'bindGitAccount',
    'cloneRepository',
    'syncRepository',
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
        readMessage: ['sessionId', 'messageId', { offset: 0, limit: 2000 }],
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
        gitRepository: ['projectId'],
        listWorktrees: ['projectId'],
        createWorktree: ['projectId', 'feature/task-name', 'HEAD'],
        removeWorktree: ['worktreeProjectId'],
        bindGitAccount: ['projectId', 'connectorId'],
        cloneRepository: [
          'connectorId',
          'https://github.com/owner/repository.git',
          'absolute/new-directory',
        ],
        syncRepository: ['projectId', 'pull'],
      },
      notes:
        '先用 snapshot 查询真实 ID。save* 使用 snapshot 中完整对象及修改字段；delete* 传 ID。Git 工作树是内置执行能力，无需配置或打开页面：任务需要隔离时用 createWorktree，返回目录与项目 ID；用 createSession(projectId) 创建绑定该目录的会话，用 listWorktrees 查看，再按需 removeWorktree。已有会话不能静默改绑目录。账号凭据只在 UI 输入。规则保存后适用其 scope；主动发送必须有用户要求的收件渠道和内容。',
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
            ? '执行同舟内置操作，管理会话、Git 工作目录和客户端配置。args 是该方法的参数数组。会话和 Agent 可为空。不得传入任何密钥。saveAgent 接收完整角色对象；setCapability 接收能力名称及布尔值；updateSession 接收会话 ID 及补丁。Git 工作树通过 createWorktree / removeWorktree 操作，无需打开配置页面。先查询真实 ID 再修改。'
            : '查询同舟当前真实状态。snapshot 返回连接、Agent、插件、Skills、会话和运行状态；messages / runEvents 接收会话 ID；readMessage 接收会话 ID、消息 ID、{offset,limit}，分段读取历史原文（默认 2000 字符，上限 8000）；computerStatus 无参数。args 为参数数组。',
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
        approval ? '执行同舟操作' : '查询同舟',
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
                (/^(secret|oauthClientSecret|password|cookies?|authorization|accessToken|refreshToken|signingSecret|webhook)$/i.test(
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
