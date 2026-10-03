import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  clipboard,
  globalShortcut,
  Menu,
  nativeTheme,
  session,
} from 'electron';
import { NativeAccount, nativeEngine } from './native-engine';
import { Accounts } from './accounts';
import { Connectors, connectorSchema } from './connectors';
import { BrowserProfiles } from './browser-profiles';
import { Channels, channelSchema, notificationRuleSchema } from './channels';
import { Feishu } from './feishu';
import { Bots, botSchema } from './bots';
import { Worktrees } from './worktrees';
import { GitRepositories } from './git-repositories';
import { McpAuth, pluginOAuth, pluginAuthIdentity } from './mcp-auth';
import { setServiceTransport } from './service-network';
import { initializeAgent } from './project-init';
import { writeClipboardText } from './clipboard';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { Runtime } from './runtime';
import { ClientCommands, operation, manual, type ClientOperation } from './client-commands';
import { DesktopComputer } from './computer';
import { computerDiagnostic } from './computer-diagnostic';
import { PluginConnection, importSkillDirectory } from './extensions';
import {
  agentSchema,
  idSchema,
  providerSchema,
  redact,
  runSchema,
  pluginSchema,
} from './validation';
import { complete, listModels } from './providers';
import { command, files, read } from './workspace';
import { importCCSwitch } from './cc-switch';
import { normalizeAppearance } from '../src/shared/appearance';
import type {
  AgentProfile,
  AppEvent,
  Project,
  Provider,
  ProviderInput,
  PluginConfig,
  SkillRecord,
  Session,
} from '../src/shared/types';

if (process.env.TONGZHOU_USER_DATA) app.setPath('userData', process.env.TONGZHOU_USER_DATA);
app.setName('Tongzhou');
let window: BrowserWindow | undefined;
let store: Store;
let runtime: Runtime;
let accounts: Accounts;
let connectors: Connectors;
let browserProfiles: BrowserProfiles;
let channels: Channels;
let feishu: Feishu;
let bots: Bots;
let mcpAuth: McpAuth;
const computer = new DesktopComputer();
const clientCommands = new ClientCommands();
let quitting = false;
const pendingImports = new Map<string, ProviderInput>();
const page = path.join(__dirname, '../dist/index.html');
function trusted(url: string) {
  return process.env.TONGZHOU_DEV_URL
    ? url === process.env.TONGZHOU_DEV_URL + '/'
    : url === pathToFileURL(page).href;
}
function emit(event: AppEvent) {
  if (window && !window.isDestroyed()) window.webContents.send('tongzhou:event', event);
}
function register(name: string, definition: ClientOperation, handler: (...args: any[]) => any) {
  clientCommands.register(name, definition, handler);
  ipcMain.handle('tongzhou:' + name, async (event, ...args) => {
    if (
      event.sender !== window?.webContents ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !trusted(event.senderFrame.url)
    )
      throw new Error('不可信的调用来源');
    try {
      return await handler(...args);
    } catch (e: any) {
      throw new Error(redact(e.message ?? String(e)));
    }
  });
}
function setup() {
  const serviceSession = session.fromPartition('tongzhou-service-network');
  setServiceTransport((input, init) =>
    serviceSession.fetch(input instanceof URL ? input.href : input, {
      ...init,
      bypassCustomProtocolHandlers: true,
    }),
  );
  const dataDir = app.getPath('userData');
  store = new Store(path.join(dataDir, 'tongzhou.db'), {
    encrypt(value) {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
      )
        throw new Error('系统安全存储不可用，拒绝明文保存密钥');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用');
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    },
  });
  runtime = new Runtime(store, dataDir, emit, computer, clientCommands);
  mcpAuth = new McpAuth(
    store,
    () => runtime.changed(),
    (url) => shell.openExternal(url),
  );
  const worktrees = new Worktrees(store, dataDir, () => runtime.changed());
  runtime.projectUnavailable = (id) => worktrees.isRemoving(id);
  register(
    'listWorktrees',
    operation('项目与 Git', 'query', '列出项目及其工作树', [idSchema.describe('projectId')]),
    (id) => worktrees.list(idSchema.parse(id)),
  );
  register(
    'createWorktree',
    operation('项目与 Git', 'change', '为项目创建隔离工作树，返回目录和项目 ID', [
      idSchema.describe('projectId'),
      z.string().min(1).describe('branch'),
      z.string().min(1).describe('ref，如 HEAD'),
    ]),
    (id, branch, ref) => worktrees.create(idSchema.parse(id), branch, ref),
  );
  register(
    'removeWorktree',
    operation('项目与 Git', 'change', '移除同舟创建且无未保存或未推送更改的工作树', [
      idSchema.describe('worktreeProjectId'),
    ]),
    (id) => worktrees.remove(idSchema.parse(id)),
  );
  register(
    'openProjectFolder',
    operation('项目与 Git', 'change', '在系统文件管理器打开项目目录', [
      idSchema.describe('projectId'),
    ]),
    async (id) => {
      const p = store.get<Project>('project', idSchema.parse(id));
      if (p.removed) throw new Error('工作树已移除');
      const error = await shell.openPath(p.path);
      if (error) throw new Error('无法打开此项目目录');
    },
  );
  const appearance = store
    .list<{ id: string; theme: 'system' | 'light' | 'dark' }>('preferences')
    .find((p) => p.id === 'appearance');
  nativeTheme.themeSource = appearance?.theme ?? 'system';
  const updateWindowTheme = () =>
    window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#17191e' : '#fafbfc');
  nativeTheme.on('updated', updateWindowTheme);
  register(
    'setTheme',
    operation('外观', 'change', '切换浅色、深色或跟随系统主题', [
      z.enum(['system', 'light', 'dark']),
    ]),
    (raw) => {
      const theme = z.enum(['system', 'light', 'dark']).parse(raw);
      const current = store.list<any>('preferences').find((p) => p.id === 'appearance');
      store.put('preferences', { ...current, id: 'appearance', theme });
      nativeTheme.themeSource = theme;
      updateWindowTheme();
      emit({ type: 'appearance', value: { theme } });
    },
  );
  register('getAppearance', operation('外观', 'query', '读取主题、界面风格、字体和字号'), () => {
    return store.list<any>('preferences').find((p) => p.id === 'appearance') ?? {};
  });
  const appearanceSchema = z.object({
    theme: z.enum(['system', 'light', 'dark']),
    style: z.enum(['graphite', 'blue', 'sand']),
    font: z.enum(['modern', 'system', 'serif']),
    textSize: z.union([z.literal(14), z.literal(16), z.literal(18)]),
  });
  register(
    'setAppearance',
    operation('外观', 'change', '设置主题、界面风格、字体和字号；立即生效并保存', [
      appearanceSchema,
    ]),
    (raw) => {
      const value = normalizeAppearance(appearanceSchema.parse(raw));
      store.put('preferences', { id: 'appearance', ...value });
      nativeTheme.themeSource = value.theme;
      updateWindowTheme();
      emit({ type: 'appearance', value });
    },
  );
  connectors = new Connectors(store, () => runtime.changed());
  const repositories = new GitRepositories(store, dataDir, () => runtime.changed());
  register(
    'gitRepository',
    operation('项目与 Git', 'query', '查询 Git 分支、状态和远程信息', [
      idSchema.describe('projectId'),
    ]),
    (id) => repositories.info(idSchema.parse(id)),
  );
  register(
    'bindGitAccount',
    operation('项目与 Git', 'change', '绑定已有代码托管账号，空字符串解绑', [
      idSchema.describe('projectId'),
      z.string().describe('connectorId'),
    ]),
    (id, connectorId) => repositories.bind(idSchema.parse(id), z.string().parse(connectorId)),
  );
  register(
    'syncRepository',
    operation('项目与 Git', 'change', '拉取或推送项目代码', [
      idSchema.describe('projectId'),
      z.enum(['pull', 'push']),
    ]),
    (id, action) => repositories.sync(idSchema.parse(id), z.enum(['pull', 'push']).parse(action)),
  );
  register(
    'cloneRepository',
    operation('项目与 Git', 'change', '使用已有账号克隆仓库到本地新目录', [
      idSchema.describe('connectorId'),
      z.string().url().describe('repositoryUrl'),
      z.string().min(1).describe('absoluteDirectory'),
    ]),
    (id, url, directory) => repositories.clone(idSchema.parse(id), url, directory),
  );
  register(
    'chooseCloneDirectory',
    manual(
      '项目与 Git',
      '选择克隆目标目录',
      'workspace',
      '需要用户在系统文件夹选择器中选择目录',
      [],
    ),
    async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: '选择克隆到的父目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    },
  );
  browserProfiles = new BrowserProfiles(store);
  feishu = new Feishu(store, runtime);
  bots = new Bots(store, runtime);
  bots.migrateLegacy();
  bots.sync();
  register(
    'saveBot',
    operation('会话机器人', 'change', '新增或修改机器人配置，凭据在界面保存', [botSchema]),
    (b) => bots.save(b),
  );
  register(
    'deleteBot',
    operation('会话机器人', 'change', '删除机器人连接', [idSchema.describe('botId')]),
    (raw) => {
      const id = idSchema.parse(raw);
      feishu.cancel(id);
      bots.remove(id);
    },
  );
  register(
    'restartBot',
    operation('会话机器人', 'change', '重新连接已有机器人', [idSchema.describe('botId')]),
    (id) => bots.restart(idSchema.parse(id)),
  );
  register(
    'onboardBot',
    manual('会话机器人', '飞书机器人扫码接入', 'connections', '需要用户扫码完成账号授权', [
      idSchema.describe('newBotId'),
      z.string().min(1).describe('name'),
    ]),
    (raw, rawName) => {
      const id = idSchema.parse(raw);
      if (bots.list().some((b) => b.id === id)) throw new Error('此机器人已存在');
      return feishu.onboard(id, z.string().min(1).max(100).parse(rawName), (c, secret) =>
        bots.authorize(c, secret),
      );
    },
  );
  channels = new Channels(store, () => {
    runtime.changed();
    feishu.sync();
  });
  feishu.sync();
  register(
    'onboardFeishu',
    manual('渠道通知', '飞书应用扫码接入', 'connections', '需要用户扫码完成账号授权', [
      idSchema,
      z.string().min(1),
    ]),
    (id, name) => {
      idSchema.parse(id);
      if (store.list<any>('channel').some((c) => c.id === id))
        throw new Error('此渠道已存在，请创建新的授权连接');
      return feishu.onboard(id, z.string().min(1).max(100).parse(name));
    },
  );
  register(
    'cancelChannelLogin',
    operation('渠道通知', 'change', '取消渠道或机器人待完成的扫码授权', [idSchema]),
    (id) => feishu.cancel(idSchema.parse(id)),
  );
  runtime.onLifecycle = (run, event, id) => {
    void channels.notify(run, event, id).catch(() => {});
  };
  register(
    'saveConnector',
    operation('服务与浏览器', 'change', '新增或修改服务连接，密钥和令牌在界面保存', [
      connectorSchema,
    ]),
    async (raw) => {
      const c = connectorSchema.parse(raw);
      const old = connectors.list().find((item) => item.id === c.id);
      connectors.save(c);
      if (old && (old.baseUrl !== c.baseUrl || old.kind !== c.kind))
        await browserProfiles.clear(c.id);
      else if (!c.enabled) browserProfiles.close(c.id);
    },
  );
  register(
    'deleteConnector',
    operation('服务与浏览器', 'change', '删除服务连接及其浏览器登录态', [
      idSchema.describe('connectorId'),
    ]),
    async (raw) => {
      const id = idSchema.parse(raw);
      await browserProfiles.clear(id);
      connectors.remove(id);
    },
  );
  register(
    'testConnector',
    operation('服务与浏览器', 'change', '检查已有账号的连接与认证状态', [
      idSchema.describe('connectorId'),
    ]),
    (id) => connectors.test(idSchema.parse(id)),
  );
  register(
    'loginConnector',
    manual(
      '服务与浏览器',
      '浏览器登录代码托管服务',
      'connections',
      '授权须由用户在浏览器完成，认证信息不进入对话',
      [idSchema.describe('connectorId')],
    ),
    async (id) => {
      const result = await connectors.login(idSchema.parse(id));
      await shell.openExternal(result.url);
      return result;
    },
  );
  register(
    'cancelConnectorLogin',
    operation('服务与浏览器', 'change', '取消服务账号授权', [idSchema.describe('connectorId')]),
    (id) => connectors.cancel(idSchema.parse(id)),
  );
  register(
    'browserProfileStatus',
    operation('服务与浏览器', 'query', '查询独立浏览器是否打开和是否保留登录态，不读取凭据内容', [
      idSchema.describe('connectorId'),
    ]),
    (id) => browserProfiles.status(idSchema.parse(id)),
  );
  register(
    'openBrowserProfile',
    operation('服务与浏览器', 'change', '打开服务独立浏览器窗口并保留登录态', [
      idSchema.describe('connectorId'),
    ]),
    (id) => browserProfiles.open(idSchema.parse(id)),
  );
  register(
    'clearBrowserProfile',
    operation('服务与浏览器', 'change', '清除指定服务的浏览器登录态', [
      idSchema.describe('connectorId'),
    ]),
    (id) => browserProfiles.clear(idSchema.parse(id)),
  );
  register(
    'saveChannel',
    operation('渠道通知', 'change', '配置通知渠道或邮件，凭据在界面保存', [channelSchema]),
    (c) => {
      channels.save(c);
      feishu.cancel(c.id);
    },
  );
  register(
    'testEmail',
    operation('渠道通知', 'change', '验证 SMTP 连接与认证，不发送邮件', [
      idSchema.describe('channelId'),
    ]),
    (id) => channels.testEmail(idSchema.parse(id)),
  );
  register(
    'deleteChannel',
    operation('渠道通知', 'change', '删除通知渠道及关联规则', [idSchema.describe('channelId')]),
    (id) => {
      idSchema.parse(id);
      feishu.cancel(id);
      channels.remove(id);
    },
  );
  register(
    'sendChannel',
    operation('渠道通知', 'change', '向用户指定的渠道发送准确内容，必须有明确发送要求', [
      idSchema.describe('channelId'),
      z.string().min(1).max(4000).describe('text'),
      idSchema.optional().describe('sessionId'),
    ]),
    (id, text, sessionId) =>
      channels.send(
        idSchema.parse(id),
        z.string().min(1).max(4000).parse(text),
        idSchema.optional().parse(sessionId),
      ),
  );
  register(
    'saveNotificationRule',
    operation('渠道通知', 'change', '保存轮次通知触发规则；须按用户要求设置通知目标和条件', [
      notificationRuleSchema,
    ]),
    (r) => channels.saveRule(r),
  );
  register(
    'deleteNotificationRule',
    operation('渠道通知', 'change', '删除通知规则', [idSchema.describe('ruleId')]),
    (id) => {
      store.remove('notificationRule', idSchema.parse(id));
      runtime.changed();
    },
  );
  register(
    'initializeAgent',
    operation('项目与 Git', 'change', '为项目生成 agent.md 初始化说明，已有说明不覆盖', [
      idSchema.describe('projectId'),
    ]),
    (id) => initializeAgent(store.get<Project>('project', idSchema.parse(id)).path),
  );
  register(
    'branchSession',
    operation('会话', 'change', '从指定消息创建会话分支', [
      idSchema.describe('sessionId'),
      idSchema.describe('messageId'),
    ]),
    (raw, rawMessage) => {
      const id = idSchema.parse(raw),
        messageId = idSchema.parse(rawMessage);
      const source = store.get<Session>('session', id);
      const messages = store.messages(id);
      const index = messages.findIndex((m) => m.id === messageId);
      if (index < 0 || messages[index].status === 'streaming')
        throw new Error('请选择已完成的历史消息');
      const copy = store.createSession(source.projectId);
      const result = {
        ...copy,
        providerId: source.providerId,
        model: source.model,
        agentId: source.agentId,
        permission: source.permission,
        title: source.title + ' · 分支',
      };
      store.db.exec('BEGIN');
      try {
        store.put('session', result);
        // Keep portable evidence; do not leave partial tool call pairs in the new branch.
        for (const m of messages.slice(0, index + 1))
          store.message({
            ...m,
            id: randomUUID(),
            sessionId: copy.id,
            runId: undefined,
            toolCalls: undefined,
            toolCallId: undefined,
            anthropicContent: undefined,
            role: m.role === 'tool' ? 'assistant' : m.role,
            content: m.role === 'tool' ? '[分支前的工具记录] ' + m.content : m.content,
          });
        store.db.exec('COMMIT');
      } catch (e) {
        store.db.exec('ROLLBACK');
        store.deleteSession(copy.id);
        throw e;
      }
      runtime.changed();
      return result;
    },
  );
  for (const engine of ['kimi', 'minimax'] as const) {
    const providerId = engine + '-account';
    if (!store.list<Provider>('provider').some((p) => p.id === providerId))
      store.saveProvider({
        id: providerId,
        name: engine === 'kimi' ? 'Kimi · 账号授权' : 'MiniMax · 账号授权',
        protocol: engine,
        auth: 'native',
        baseUrl: '',
        models: [],
        maxOutputTokens: 8192,
        contextChars: 0,
      });
  }
  accounts = new Accounts(store, runtime, dataDir, emit, (url) => shell.openExternal(url));
  const accountFor = (raw: unknown, id?: unknown) =>
    accounts.native(
      z.enum(['kimi', 'minimax']).parse(raw),
      id === undefined ? undefined : idSchema.parse(id),
    );
  register(
    'nativeStatus',
    operation('模型连接与认证', 'query', '查询 Kimi 或 MiniMax 账号认证状态', [
      z.enum(['kimi', 'minimax']),
      idSchema.optional().describe('providerId'),
    ]),
    (raw, id) => accountFor(raw, id).read(),
  );
  register(
    'nativeLogin',
    manual(
      '模型连接与认证',
      '启动 Kimi 或 MiniMax 账号登录',
      'providers',
      '需要用户在官方页面完成账号授权',
      [z.enum(['kimi', 'minimax']), z.enum(['cn', 'global']), idSchema.optional()],
    ),
    (raw, region, id) => {
      accounts.idle(idSchema.parse(id ?? raw + '-account'));
      return accountFor(raw, id).start(z.enum(['cn', 'global']).parse(region));
    },
  );
  register(
    'nativeCancel',
    operation('模型连接与认证', 'change', '取消 Kimi 或 MiniMax 登录', [
      z.enum(['kimi', 'minimax']),
      idSchema.optional(),
    ]),
    (raw, id) => accountFor(raw, id).cancel(),
  );
  register(
    'nativeOpen',
    manual('模型连接与认证', '打开正在等待的官方授权页面', 'providers', '需要用户本人完成授权', [
      z.enum(['kimi', 'minimax']),
      idSchema.optional(),
    ]),
    (raw, id) => {
      const state = accountFor(raw, id).state;
      if (state.phase !== 'waiting' || !state.url) throw new Error('授权链接已失效，请重新登录');
      return shell.openExternal(state.url);
    },
  );
  register(
    'nativeCopyCode',
    manual(
      '模型连接与认证',
      '复制当前设备授权码',
      'providers',
      '设备授权码仅显示给用户，不传入模型',
      [z.enum(['kimi', 'minimax']), idSchema.optional()],
    ),
    (raw, id) => {
      const state = accountFor(raw, id).state;
      if (state.phase !== 'waiting' || !state.userCode) throw new Error('设备码已失效');
      return writeClipboardText(clipboard, state.userCode);
    },
  );
  register(
    'nativeLogout',
    operation('模型连接与认证', 'change', '退出指定 Kimi 或 MiniMax 账号', [
      z.enum(['kimi', 'minimax']),
      idSchema.optional(),
    ]),
    async (raw, id) => {
      accounts.idle(idSchema.parse(id ?? raw + '-account'));
      await accountFor(raw, id).logout();
      runtime.changed();
    },
  );
  const requireIdle = () => {
    // Per-run scope remains frozen; dispatch rechecks global revocation.
  };
  register(
    'setCapability',
    operation('核心能力', 'change', '启用或停用内置能力，工具可用性从下一轮生效', [
      z.enum(['computer', 'management']),
      z.boolean(),
    ]),
    (raw, enabled) => {
      store.setCapability(
        z.enum(['computer', 'management']).parse(raw),
        z.boolean().parse(enabled),
      );
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'installBuiltinPlugin',
    operation('插件', 'change', '安装内置网页读取与时间插件', []),
    () => {
      const require = createRequire(path.join(__dirname, '../package.json'));
      const nodeRoot = path
        .dirname(require.resolve('node/package.json'))
        .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
      store.put('plugin', {
        id: 'tongzhou-web',
        name: '网页读取与时间 · 内置',
        transport: 'stdio',
        command: path.join(nodeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
        args: [
          path
            .join(__dirname, 'builtin-mcp.cjs')
            .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
        ],
        url: '',
        enabled: true,
        readOnlyTools: ['fetch_page', 'current_time'],
      } satisfies PluginConfig);
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'runEvents',
    operation('会话', 'query', '查询会话运行事件和进度', [idSchema.describe('sessionId')]),
    (id) => runtime.events(idSchema.parse(id)),
  );
  register(
    'enqueue',
    operation(
      '会话',
      'change',
      '给其他会话补充内容、排队下一轮或重新运行',
      [runSchema, z.enum(['supplement', 'next', 'restart'])],
      {
        guard: (args, current) => {
          if ((args[0] as { sessionId: string }).sessionId === current)
            throw new Error('请使用当前会话的输入框或菜单操作当前任务');
        },
      },
    ),
    (input, mode) =>
      runtime.enqueue(
        runSchema.parse(input),
        z.enum(['supplement', 'next', 'restart']).parse(mode),
      ),
  );
  register(
    'cancelInput',
    operation('会话', 'change', '取消排队输入', [idSchema.describe('inputId')]),
    (id) => runtime.cancelInput(idSchema.parse(id)),
  );
  register(
    'resumeInput',
    operation('会话', 'change', '恢复暂停的排队输入', [idSchema.describe('inputId')]),
    (id) => runtime.resumeInput(idSchema.parse(id)),
  );
  register(
    'editInput',
    operation('会话', 'change', '修改排队输入内容', [
      idSchema.describe('inputId'),
      z.string().min(1).max(100000),
    ]),
    (id, prompt) => runtime.editInput(idSchema.parse(id), z.string().max(100000).parse(prompt)),
  );
  register(
    'deleteSession',
    operation(
      '会话',
      'change',
      '删除会话及消息记录，不能删除当前执行会话',
      [idSchema.describe('sessionId')],
      {
        guard: (args, current) => {
          if (args[0] === current) throw new Error('请使用当前会话的输入框或菜单操作当前任务');
        },
      },
    ),
    async (id) => {
      idSchema.parse(id);
      channels.abort(id);
      await runtime.deleteSession(id);
      feishu.sync();
    },
  );
  register(
    'savePlugin',
    operation('插件', 'change', '保存或启停 MCP 插件配置，凭据在界面输入', [pluginSchema]),
    (raw) => {
      requireIdle();
      const { secret, clearSecret, oauthClientSecret, clearOAuthClientSecret, ...config } =
        pluginSchema.parse(raw);
      const previous = store.list<PluginConfig>('plugin').find((p) => p.id === config.id);
      const identityChanged =
        !!previous &&
        (pluginAuthIdentity(previous) !== pluginAuthIdentity(config) ||
          previous.command !== config.command ||
          JSON.stringify(previous.args) !== JSON.stringify(config.args));
      const clientSecretChanged = !!oauthClientSecret || !!clearOAuthClientSecret;
      if (identityChanged || clearSecret || clientSecretChanged) mcpAuth.logout(config.id);
      store.saveSecret(
        'plugin_oauth_client_' + config.id,
        config.authMode === 'oauth' ? oauthClientSecret : undefined,
        identityChanged || clearOAuthClientSecret || config.authMode !== 'oauth',
      );
      const same =
        previous &&
        !identityChanged &&
        !secret &&
        !clearSecret &&
        !clientSecretChanged &&
        previous.transport === config.transport &&
        previous.command === config.command &&
        previous.url === config.url &&
        JSON.stringify(previous.args) === JSON.stringify(config.args);
      if (identityChanged) store.saveSecret('plugin_' + config.id, undefined, true);
      store.saveSecret('plugin_' + config.id, secret, clearSecret || config.authMode === 'oauth');
      store.put('plugin', {
        ...config,
        oauthStatus:
          config.authMode === 'oauth' && !identityChanged && !clearSecret && !clientSecretChanged
            ? previous?.oauthStatus
            : undefined,
        oauthError:
          !identityChanged && !clearSecret && !clientSecretChanged
            ? previous?.oauthError
            : undefined,
        ...(same ? { catalog: previous.catalog, checkedAt: previous.checkedAt } : {}),
      });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'deletePlugin',
    operation('插件', 'change', '删除 MCP 插件', [idSchema.describe('pluginId')]),
    (raw) => {
      requireIdle();
      const id = idSchema.parse(raw);
      mcpAuth.logout(id);
      store.remove('plugin', id);
      store.saveSecret('plugin_' + id, undefined, true);
      store.saveSecret('plugin_oauth_client_' + id, undefined, true);
      for (const a of store.list<AgentProfile>('agent'))
        store.put('agent', { ...a, pluginIds: a.pluginIds?.filter((p) => p !== id) });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'testPlugin',
    operation('插件', 'change', '连接插件并发现其工具', [idSchema.describe('pluginId')]),
    async (raw) => {
      requireIdle();
      const p = store.get<PluginConfig>('plugin', idSchema.parse(raw));
      const c = new PluginConnection(p, store.secret('plugin_' + p.id), pluginOAuth(store, p));
      try {
        const signal = AbortSignal.timeout(30000);
        await c.connect(signal);
        const catalog = (await c.tools(signal)).map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema,
        }));
        const current = store.get<PluginConfig>('plugin', p.id);
        if (JSON.stringify(current) !== JSON.stringify(p))
          throw new Error('插件配置已变更，请重新检查');
        store.put('plugin', { ...p, catalog, checkedAt: Date.now() });
        runtime.changed();
        return catalog;
      } finally {
        await c.close();
      }
    },
  );
  register(
    'loginPlugin',
    manual('插件', '开始插件 OAuth 浏览器认证', 'extensions', '需要用户本人完成浏览器授权', [
      idSchema.describe('pluginId'),
    ]),
    (raw) => {
      requireIdle();
      return mcpAuth.login(idSchema.parse(raw));
    },
  );
  register(
    'cancelPluginLogin',
    operation('插件', 'change', '取消插件待完成的授权', [idSchema.describe('pluginId')]),
    (raw) => mcpAuth.cancel(idSchema.parse(raw)),
  );
  register(
    'logoutPlugin',
    operation('插件', 'change', '退出插件账号授权', [idSchema.describe('pluginId')]),
    (raw) => {
      requireIdle();
      mcpAuth.logout(idSchema.parse(raw));
      runtime.invalidateNative();
    },
  );
  register(
    'useGithubConnector',
    operation('插件', 'change', '将已有 GitHub 账号用于官方 GitHub MCP', [
      idSchema.describe('pluginId'),
      idSchema.describe('connectorId'),
    ]),
    (rawPlugin, rawConnector) => {
      requireIdle();
      const p = store.get<PluginConfig>('plugin', idSchema.parse(rawPlugin));
      const c = connectors.list().find((c) => c.id === idSchema.parse(rawConnector));
      if (
        p.url !== 'https://api.githubcopilot.com/mcp/' ||
        p.transport !== 'http' ||
        p.authMode === 'oauth' ||
        c?.kind !== 'github' ||
        new URL(c.baseUrl).origin !== 'https://github.com' ||
        !c.enabled
      )
        throw new Error('仅可将启用的 GitHub 官方站点账号连接到官方 GitHub MCP');
      const token = store.secret('connector_' + c.id);
      if (!token) throw new Error('此 GitHub 账号尚未保存访问令牌');
      store.saveSecret('plugin_' + p.id, JSON.stringify({ Authorization: 'Bearer ' + token }));
      store.put('plugin', { ...p, catalog: undefined, checkedAt: undefined });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'importSkill',
    manual(
      'Skills',
      '从目录导入 SKILL.md 技能',
      'extensions',
      '需要用户在文件夹选择器中选择技能目录',
      [],
    ),
    async () => {
      requireIdle();
      const chosen = await dialog.showOpenDialog(window!, {
        title: '选择包含 SKILL.md 的目录',
        properties: ['openDirectory'],
      });
      if (chosen.canceled) return null;
      const skill = await importSkillDirectory(chosen.filePaths[0]);
      store.put('skill', skill);
      runtime.changed();
      return skill;
    },
  );
  register(
    'saveSkill',
    operation('Skills', 'change', '修改或启停已导入的技能', [
      z.object({
        id: idSchema,
        name: z.string().min(1).max(100),
        description: z.string().max(500),
        instructions: z.string().max(32000),
        enabled: z.boolean(),
      }),
    ]),
    (raw) => {
      requireIdle();
      const p = z
        .object({
          id: idSchema,
          name: z.string().min(1).max(100),
          description: z.string().max(500),
          instructions: z.string().max(32000),
          enabled: z.boolean(),
        })
        .parse(raw);
      const old = store.get<SkillRecord>('skill', p.id);
      store.put('skill', { ...old, ...p });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'deleteSkill',
    operation('Skills', 'change', '删除已导入技能', [idSchema.describe('skillId')]),
    (raw) => {
      requireIdle();
      const id = idSchema.parse(raw);
      store.remove('skill', id);
      for (const a of store.list<AgentProfile>('agent'))
        store.put('agent', { ...a, skillIds: a.skillIds?.filter((s) => s !== id) });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  const computerStatus = () => ({
    ...computer.status(),
    diagnostic: store.list<any>('computerDiagnostic')[0],
  });
  register(
    'computerStatus',
    operation('电脑控制', 'query', '查询电脑控制平台状态及上次自检结果', []),
    computerStatus,
  );
  register(
    'computerPermission',
    manual('电脑控制', '检查或申请系统权限', 'extensions', '系统授权需要用户确认', []),
    () => {
      computer.requestPermission();
      return computerStatus();
    },
  );
  let diagnosing = false;
  register(
    'computerSelfTest',
    manual(
      '电脑控制',
      '运行电脑控制本机自检',
      'extensions',
      '自检需保持测试窗口可见且所有会话空闲，请在能力卡片操作',
      [],
    ),
    async () => {
      if (diagnosing) throw new Error('自检正在进行');
      if (runtime.snapshot().runs.some((r) => r.status === 'running'))
        throw new Error('有任务正在运行，请等待结束或停止任务后再检测电脑控制。');
      diagnosing = true;
      try {
        const result = await computerDiagnostic(computer);
        store.put('computerDiagnostic', { id: 'current', ...result });
        return computerStatus();
      } finally {
        diagnosing = false;
      }
    },
  );
  register(
    'emergencyStop',
    manual(
      '电脑控制',
      '停止全部运行任务',
      'extensions',
      '包含当前任务，请使用停止按钮或紧急停止快捷键',
      [],
    ),
    async () => {
      for (const r of runtime.snapshot().runs)
        if (r.status === 'running') await runtime.cancel(r.sessionId);
    },
  );
  register(
    'snapshot',
    operation(
      '客户端',
      'query',
      '查询所有模块的真实配置、ID、会话、机器人、渠道、运行和认证记录',
      [],
    ),
    () => runtime.snapshot(),
  );
  // Privilege changes are renderer-only controls, not model-callable client commands.
  const permissionSchema = z.enum(['read-only', 'ask', 'full-access']);
  register(
    'setDefaultPermission',
    manual('权限', '设置全局执行权限', 'settings', 'Agent 不能自行提升权限，请由用户在设置中修改', [
      z.enum(['read-only', 'ask', 'full-access']),
      z.boolean().optional(),
    ]),
    (mode, all) => {
      const selected = permissionSchema.parse(mode);
      const applyToAll = z.boolean().parse(all ?? false);
      // The renderer snapshot can lag a just-saved selection. Applying the current
      // default must not restore the previous value while clearing overrides.
      store.setDefaultPermission(applyToAll ? store.defaultPermission() : selected, applyToAll);
      runtime.changed();
    },
  );
  register(
    'setSessionPermission',
    manual(
      '权限',
      '设置会话执行权限',
      'workspace',
      'Agent 不能自行提升权限，请由用户在会话中修改',
      [idSchema, z.enum(['read-only', 'ask', 'full-access']).nullable()],
    ),
    (id, mode) => {
      store.setSessionPermission(idSchema.parse(id), permissionSchema.nullable().parse(mode));
      runtime.changed();
    },
  );
  register(
    'copyText',
    manual(
      '客户端',
      '复制内容到系统剪贴板',
      'workspace',
      '请使用消息复制按钮，避免覆盖用户剪贴板',
      [z.string().max(2000000)],
    ),
    (text) => writeClipboardText(clipboard, z.string().max(2000000).parse(text)),
  );
  register(
    'openExternalLink',
    operation('客户端', 'change', '在浏览器打开 HTTP 或 HTTPS 网页', [z.string().url().max(8192)]),
    async (value) => {
      const url = new URL(z.string().max(8192).parse(value));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('只支持打开 HTTP 或 HTTPS 网页链接');
      await shell.openExternal(url.href);
    },
  );
  register(
    'clientMethods',
    operation('客户端', 'query', '查询完整客户端能力目录；优先用 client_catalog 按需查询', []),
    () => clientCommands.describe(),
  );
  register(
    'openModule',
    operation('客户端', 'change', '打开对应功能页面', [
      z.enum([
        'workspace',
        'providers',
        'agents',
        'activity',
        'settings',
        'connections',
        'extensions',
        'projects',
      ]),
    ]),
    (view) =>
      emit({
        type: 'navigate',
        view: z
          .enum([
            'workspace',
            'providers',
            'agents',
            'activity',
            'settings',
            'connections',
            'extensions',
            'projects',
          ])
          .transform((value) => (value === 'projects' ? ('workspace' as const) : value))
          .parse(view),
      }),
  );
  register(
    'messages',
    operation('会话', 'query', '分页查看会话历史消息', [
      idSchema.describe('sessionId'),
      z
        .object({ before: idSchema.optional(), limit: z.number().int().min(1).max(500).optional() })
        .optional(),
    ]),
    (id, raw) => {
      const options = z
        .object({ before: idSchema.optional(), limit: z.number().int().min(1).max(500).optional() })
        .parse(raw ?? {});
      return store.messagesPage(idSchema.parse(id), options.before, options.limit);
    },
  );
  register(
    'readMessage',
    operation('会话', 'query', '分段读取消息完整原文', [
      idSchema.describe('sessionId'),
      idSchema.describe('messageId'),
      z
        .object({
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(8000).optional(),
        })
        .optional(),
    ]),
    (sessionId, messageId, raw) => {
      const options = z
        .object({
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(8000).optional(),
        })
        .parse(raw ?? {});
      return store.readMessage(
        idSchema.parse(sessionId),
        idSchema.parse(messageId),
        options.offset,
        options.limit,
      );
    },
  );
  register(
    'saveProvider',
    operation('模型连接与认证', 'change', '保存模型连接配置，使用完整对象，密钥在界面保存', [
      providerSchema,
    ]),
    (raw) => {
      const input = providerSchema.parse(raw);
      const pending = pendingImports.get(input.id);
      const result = store.saveProvider({ ...input, secret: input.secret || pending?.secret });
      pendingImports.delete(input.id);
      runtime.changed();
      return result;
    },
  );
  register(
    'deleteProvider',
    operation('模型连接与认证', 'change', '删除模型连接及认证', [idSchema.describe('providerId')]),
    (raw) => {
      const id = idSchema.parse(raw);
      if (runtime.snapshot().runs.some((r) => r.providerId === id && r.status === 'running'))
        throw new Error('此连接正在执行任务');
      store.deleteProvider(id);
      accounts.forget(id);
      runtime.changed();
    },
  );
  register(
    'testProvider',
    operation('模型连接与认证', 'change', '测试连接和指定模型，API 连接会发起一次实际请求', [
      idSchema.describe('providerId'),
      z.string().min(1).max(200).describe('model'),
    ]),
    async (raw, model) => {
      const p = store.get<Provider>('provider', idSchema.parse(raw));
      const selected = z.string().min(1).max(200).parse(model);
      if (nativeEngine(p.protocol)) {
        const catalog = await accounts.native(p.protocol, p.id).catalog();
        store.put('provider', { ...p, models: catalog.models, modelLabels: catalog.modelLabels });
        runtime.changed();
        return '账号已通过官方引擎验证，模型列表已同步；实际调用权限以账号套餐为准。';
      }
      if (p.protocol === 'codex') {
        await runtime.authClientFor(p.id).start();
        const a = await runtime.authClientFor(p.id).request('account/read', {});
        if (!a.account) throw new Error('尚未登录 ChatGPT');
        return 'Codex 已连接，账号已登录。模型访问权限以实际执行为准。';
      }
      const result = await complete({
        provider: { ...p, maxOutputTokens: 256 },
        secret: store.secret(p.id),
        model: selected,
        instructions: 'Reply briefly.',
        messages: [
          {
            id: 'test',
            sessionId: 'test',
            role: 'user',
            content: 'Reply with OK.',
            createdAt: Date.now(),
          },
        ],
        tools: [],
        signal: AbortSignal.timeout(30000),
        onDelta: () => {},
      });
      return `连接成功：${result.text.slice(0, 120)}`;
    },
  );
  register(
    'models',
    operation('模型连接与认证', 'change', '获取并更新连接的模型列表', [
      idSchema.describe('providerId'),
    ]),
    async (raw) => {
      const p = store.get<Provider>('provider', idSchema.parse(raw));
      let models: string[];
      if (nativeEngine(p.protocol)) {
        const catalog = await accounts.native(p.protocol, p.id).catalog();
        store.put('provider', { ...p, models: catalog.models, modelLabels: catalog.modelLabels });
        runtime.changed();
        return catalog.models;
      }
      if (p.protocol === 'codex') {
        await runtime.authClientFor(p.id).start();
        const result = await runtime
          .authClientFor(p.id)
          .request('model/list', { includeHidden: false });
        models = result.data.map((m: any) => m.model ?? m.id);
      } else {
        models = await listModels(p, store.secret(p.id));
      }
      const current = store.get<Provider>('provider', p.id);
      if (current.baseUrl !== p.baseUrl || current.protocol !== p.protocol)
        throw new Error('连接已变更，请重新获取模型');
      models = [...new Set(models.filter((m) => typeof m === 'string' && m.trim()))];
      store.put('provider', { ...current, models: [...new Set([...current.models, ...models])] });
      runtime.changed();
      return models;
    },
  );
  register(
    'saveAgent',
    operation('Agent', 'change', '新增或修改 Agent 角色配置', [agentSchema]),
    (raw) => {
      const a = agentSchema.parse(raw);
      if (a.providerId) store.get('provider', a.providerId);
      for (const id of a.pluginIds ?? []) store.get('plugin', id);
      for (const id of a.skillIds ?? []) store.get('skill', id);
      store.put('agent', a);
      runtime.changed();
      return a;
    },
  );
  register(
    'deleteAgent',
    operation('Agent', 'change', '删除 Agent 角色', [idSchema.describe('agentId')]),
    (raw) => {
      const id = idSchema.parse(raw);
      store.remove('agent', id);
      for (const s of store.list<Session>('session'))
        if (s.agentId === id) store.put('session', { ...s, agentId: '' });
      runtime.changed();
    },
  );
  register(
    'addProject',
    manual(
      '项目与 Git',
      '选择已有项目目录',
      'workspace',
      '需要用户在文件夹选择器中选择本地目录',
      [],
    ),
    async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: '选择项目目录',
        properties: ['openDirectory'],
      });
      if (result.canceled) return null;
      const selected = await realpath(result.filePaths[0]);
      if (!(await stat(selected)).isDirectory()) throw new Error('请选择目录');
      const previous = store.list<Project>('project').find((p) => p.path === selected);
      if (previous) return previous;
      const project = store.put('project', {
        id: randomUUID(),
        name: path.basename(selected),
        path: selected,
        createdAt: Date.now(),
      });
      runtime.changed();
      return project;
    },
  );
  register(
    'createSession',
    operation('会话', 'change', '新建普通会话或项目会话', [
      idSchema.nullable().optional().describe('projectId，留空创建普通聊天'),
    ]),
    (id) => {
      if (id && store.get<Project>('project', idSchema.parse(id)).removed)
        throw new Error('工作树已移除，不能创建新会话');
      const s = store.createSession(idSchema.nullish().parse(id) ?? null);
      runtime.changed();
      return s;
    },
  );
  register(
    'updateSession',
    operation('会话', 'change', '修改标题、归档状态或模型连接；运行中不能切换连接', [
      idSchema.describe('sessionId'),
      z.object({
        title: z.string().min(1).max(120).optional(),
        archived: z.boolean().optional(),
        providerId: idSchema.optional(),
        model: z.string().min(1).max(200).optional(),
      }),
    ]),
    (raw, patch) => {
      const id = idSchema.parse(raw);
      const update = z
        .object({
          title: z.string().trim().min(1).max(120).optional(),
          archived: z.boolean().optional(),
          providerId: idSchema.optional(),
          model: z.string().max(200).optional(),
        })
        .parse(patch);
      if (
        runtime.isActive(id) &&
        (update.archived || update.providerId !== undefined || update.model !== undefined)
      )
        throw new Error('请先停止执行，再切换模型');
      if (update.providerId) store.get('provider', update.providerId);
      store.put('session', {
        ...store.get<Session>('session', id),
        ...update,
        updatedAt: Date.now(),
      });
      runtime.changed();
    },
  );
  register(
    'run',
    operation('会话', 'change', '启动其他会话的任务', [runSchema], {
      guard: (args, current) => {
        if ((args[0] as { sessionId: string }).sessionId === current)
          throw new Error('请使用当前会话的输入框或菜单操作当前任务');
      },
    }),
    (input) => runtime.start(runSchema.parse(input)),
  );
  register(
    'team',
    operation(
      '会话',
      'change',
      '在其他会话启动最多三个 Agent 协作',
      [runSchema, z.array(idSchema).min(1).max(3)],
      {
        guard: (args, current) => {
          if ((args[0] as { sessionId: string }).sessionId === current)
            throw new Error('请使用当前会话的输入框或菜单操作当前任务');
        },
      },
    ),
    (input, ids) =>
      runtime.team(runSchema.parse(input), z.array(idSchema).min(1).max(3).parse(ids)),
  );
  register(
    'cancel',
    operation('会话', 'change', '停止指定其他会话的任务', [idSchema.describe('sessionId')], {
      guard: (args, current) => {
        if (args[0] === current) throw new Error('请使用当前会话的输入框或菜单操作当前任务');
      },
    }),
    (id) => runtime.cancel(idSchema.parse(id)),
  );
  register(
    'approve',
    manual(
      '权限',
      '批准或拒绝待审批操作',
      'workspace',
      '只有用户可以审批，Agent 不能批准自身或其他会话的操作',
      [idSchema, z.boolean()],
    ),
    (id, allow) => runtime.approve(idSchema.parse(id), z.boolean().parse(allow)),
  );
  register(
    'listFiles',
    operation('项目与 Git', 'query', '列出项目相对目录的文件', [
      idSchema.describe('projectId'),
      z.string().max(1000).describe('relativePath，根目录用空字符串'),
    ]),
    (id, relative) =>
      files(
        store.get<Project>('project', idSchema.parse(id)).path,
        z.string().max(1000).parse(relative),
      ),
  );
  register(
    'readFile',
    operation('项目与 Git', 'query', '读取项目相对路径文件', [
      idSchema.describe('projectId'),
      z.string().max(1000).describe('relativePath'),
    ]),
    (id, relative) =>
      read(
        store.get<Project>('project', idSchema.parse(id)).path,
        z.string().max(1000).parse(relative),
      ),
  );
  register(
    'diff',
    operation('项目与 Git', 'query', '查询项目 Git 状态和更改差异', [
      idSchema.describe('projectId'),
    ]),
    async (id) => {
      const root = store.get<Project>('project', idSchema.parse(id)).path;
      const signal = AbortSignal.timeout(15000);
      const status = await command('git', ['status', '--short'], root, signal);
      const diff = await command(
        'git',
        ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
        root,
        signal,
      );
      return status + '\n\n' + diff;
    },
  );
  register(
    'importCCSwitch',
    manual(
      '模型连接与认证',
      '从本地配置文件导入连接',
      'providers',
      '需要用户选择并确认导入的配置，凭据不经过模型',
      [],
    ),
    async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: '导入 CC Switch 配置',
        filters: [{ name: 'CC Switch', extensions: ['db', 'sqlite', 'sqlite3', 'json'] }],
        properties: ['openFile'],
      });
      if (result.canceled) return null;
      const preview = await importCCSwitch(result.filePaths[0]);
      pendingImports.clear();
      for (const provider of preview.providers) pendingImports.set(provider.id, provider);
      return {
        ...preview,
        providers: preview.providers.map(({ secret, ...p }) => ({ ...p, hasSecret: !!secret })),
      };
    },
  );
  register(
    'exportSession',
    manual('会话', '导出会话为 Markdown', 'workspace', '需要用户在保存对话框中选择文件位置', [
      idSchema.describe('sessionId'),
    ]),
    async (raw) => {
      const id = idSchema.parse(raw);
      const s = store.get<Session>('session', id);
      const result = await dialog.showSaveDialog(window!, {
        title: '导出会话',
        defaultPath: `Tongzhou-${s.id.slice(0, 8)}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return null;
      const content =
        `# ${s.title}\n\n导出自同舟 · ${new Date().toISOString()}\n\n` +
        store
          .messages(id)
          .map((m) => `## ${m.agent ?? m.role}${m.model ? ' · ' + m.model : ''}\n\n${m.content}\n`)
          .join('\n');
      await writeFile(result.filePath, redact(content), 'utf8');
      return result.filePath;
    },
  );
  const codexFor = (id?: unknown) =>
    accounts.codex(id === undefined ? undefined : idSchema.parse(id));
  register(
    'codexStatus',
    operation('模型连接与认证', 'query', '查询 ChatGPT 账号认证状态', [
      idSchema.optional().describe('providerId'),
    ]),
    (id) => codexFor(id).read(),
  );
  register(
    'codexLogin',
    manual(
      '模型连接与认证',
      '启动 ChatGPT 浏览器或设备登录',
      'providers',
      '需要用户本人在官方页面完成授权',
      [z.enum(['browser', 'device']).optional(), idSchema.optional()],
    ),
    (method, id) => {
      accounts.idle(idSchema.parse(id ?? 'openai-codex'));
      return codexFor(id).start(z.enum(['browser', 'device']).parse(method ?? 'browser'));
    },
  );
  register(
    'codexLoginRetry',
    manual('模型连接与认证', '重试 ChatGPT 登录', 'providers', '需要用户本人完成授权', [
      z.enum(['browser', 'device']),
      idSchema.optional(),
    ]),
    (method, id) => {
      accounts.idle(idSchema.parse(id ?? 'openai-codex'));
      return codexFor(id).restart(z.enum(['browser', 'device']).parse(method));
    },
  );
  register(
    'codexLoginCancel',
    operation('模型连接与认证', 'change', '取消 ChatGPT 登录', [idSchema.optional()]),
    (id) => codexFor(id).cancel(),
  );
  register(
    'codexLoginOpen',
    manual('模型连接与认证', '打开 ChatGPT 授权页面', 'providers', '需要用户本人完成授权', [
      idSchema.optional(),
    ]),
    (id) => codexFor(id).openPage(),
  );
  register(
    'codexLoginCopyCode',
    manual(
      '模型连接与认证',
      '复制 ChatGPT 设备码',
      'providers',
      '设备授权码仅显示给用户，不传入模型',
      [idSchema.optional()],
    ),
    (id) => writeClipboardText(clipboard, codexFor(id).code()),
  );
  register(
    'codexLogout',
    operation('模型连接与认证', 'change', '退出 ChatGPT 账号', [idSchema.optional()]),
    async (id) => {
      accounts.idle(idSchema.parse(id ?? 'openai-codex'));
      await codexFor(id).logout();
      runtime.changed();
    },
  );
}
async function createWindow() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
    ]),
  );
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    title: '同舟 Tongzhou',
    icon: path.join(__dirname, '../build/icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191e' : '#fafbfc',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.selectionText) items.push({ label: '复制', role: 'copy' });
    if (params.isEditable)
      items.push({ label: '剪切', role: 'cut' }, { label: '粘贴', role: 'paste' });
    if (!items.length) return;
    items.push({ type: 'separator' }, { label: '全选', role: 'selectAll' });
    Menu.buildFromTemplate(items).popup({ window });
  });
  window.once('ready-to-show', () => window?.show());
  if (process.env.TONGZHOU_DEV_URL) await window.loadURL(process.env.TONGZHOU_DEV_URL);
  else await window.loadFile(page);
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      setup();
      await createWindow();
      computer.emergencyShortcut = globalShortcut.register('CommandOrControl+Alt+Escape', () => {
        for (const r of runtime.snapshot().runs)
          if (r.status === 'running') void runtime.cancel(r.sessionId);
      });
    })
    .catch((error) => {
      dialog.showErrorBox('同舟启动失败', redact(String(error)));
      app.exit(1);
    });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting || !runtime) return;
    event.preventDefault();
    quitting = true;
    globalShortcut.unregisterAll();
    accounts.dispose();
    connectors.dispose();
    browserProfiles.dispose();
    channels.dispose();
    feishu.dispose();
    bots.dispose();
    mcpAuth.dispose();
    runtime.stop();
    void runtime.waitForIdle().finally(() => {
      store.close();
      app.quit();
    });
  });
}
