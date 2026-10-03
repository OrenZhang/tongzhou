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
} from 'electron';
import { NativeAccount, nativeEngine } from './native-engine';
import { Accounts } from './accounts';
import { Connectors } from './connectors';
import { BrowserProfiles } from './browser-profiles';
import { Channels } from './channels';
import { Feishu } from './feishu';
import { Bots } from './bots';
import { Worktrees } from './worktrees';
import { McpAuth, pluginOAuth, pluginAuthIdentity } from './mcp-auth';
import { initializeAgent } from './project-init';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { Runtime } from './runtime';
import { ClientCommands } from './client-commands';
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
function register(name: string, handler: (...args: any[]) => any) {
  clientCommands.register(name, handler);
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
  register('listWorktrees', (id) => worktrees.list(idSchema.parse(id)));
  register('createWorktree', (id, branch, ref) =>
    worktrees.create(idSchema.parse(id), branch, ref),
  );
  register('removeWorktree', (id) => worktrees.remove(idSchema.parse(id)));
  register('openProjectFolder', async (id) => {
    const p = store.get<Project>('project', idSchema.parse(id));
    if (p.removed) throw new Error('工作树已移除');
    const error = await shell.openPath(p.path);
    if (error) throw new Error('无法打开此项目目录');
  });
  const appearance = store
    .list<{ id: string; theme: 'system' | 'light' | 'dark' }>('preferences')
    .find((p) => p.id === 'appearance');
  nativeTheme.themeSource = appearance?.theme ?? 'system';
  const updateWindowTheme = () =>
    window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#17191e' : '#fafbfc');
  nativeTheme.on('updated', updateWindowTheme);
  register('setTheme', (raw) => {
    const theme = z.enum(['system', 'light', 'dark']).parse(raw);
    store.put('preferences', { id: 'appearance', theme });
    nativeTheme.themeSource = theme;
    updateWindowTheme();
  });
  connectors = new Connectors(store, () => runtime.changed());
  browserProfiles = new BrowserProfiles(store);
  feishu = new Feishu(store, runtime);
  bots = new Bots(store, runtime);
  bots.migrateLegacy();
  bots.sync();
  register('saveBot', (b) => bots.save(b));
  register('deleteBot', (raw) => {
    const id = idSchema.parse(raw);
    feishu.cancel(id);
    bots.remove(id);
  });
  register('restartBot', (id) => bots.restart(idSchema.parse(id)));
  register('onboardBot', (raw, rawName) => {
    const id = idSchema.parse(raw);
    if (bots.list().some((b) => b.id === id)) throw new Error('此机器人已存在');
    return feishu.onboard(id, z.string().min(1).max(100).parse(rawName), (c, secret) =>
      bots.authorize(c, secret),
    );
  });
  channels = new Channels(store, () => {
    runtime.changed();
    feishu.sync();
  });
  feishu.sync();
  register('onboardFeishu', (id, name) => {
    idSchema.parse(id);
    if (store.list<any>('channel').some((c) => c.id === id))
      throw new Error('此渠道已存在，请创建新的授权连接');
    return feishu.onboard(id, z.string().min(1).max(100).parse(name));
  });
  register('cancelChannelLogin', (id) => feishu.cancel(idSchema.parse(id)));
  runtime.onLifecycle = (run, event, id) => {
    void channels.notify(run, event, id).catch(() => {});
  };
  register('saveConnector', (c) => connectors.save(c));
  register('deleteConnector', async (raw) => {
    const id = idSchema.parse(raw);
    await browserProfiles.clear(id);
    connectors.remove(id);
  });
  register('testConnector', (id) => connectors.test(idSchema.parse(id)));
  register('loginConnector', async (id) => {
    const result = await connectors.login(idSchema.parse(id));
    await shell.openExternal(result.url);
    return result;
  });
  register('cancelConnectorLogin', (id) => connectors.cancel(idSchema.parse(id)));
  register('openBrowserProfile', (id) => browserProfiles.open(idSchema.parse(id)));
  register('clearBrowserProfile', (id) => browserProfiles.clear(idSchema.parse(id)));
  register('saveChannel', (c) => {
    channels.save(c);
    feishu.cancel(c.id);
  });
  register('testEmail', (id) => channels.testEmail(idSchema.parse(id)));
  register('deleteChannel', (id) => {
    idSchema.parse(id);
    feishu.cancel(id);
    channels.remove(id);
  });
  register('sendChannel', (id, text, sessionId) =>
    channels.send(
      idSchema.parse(id),
      z.string().min(1).max(4000).parse(text),
      idSchema.optional().parse(sessionId),
    ),
  );
  register('saveNotificationRule', (r) => channels.saveRule(r));
  register('deleteNotificationRule', (id) => {
    store.remove('notificationRule', idSchema.parse(id));
    runtime.changed();
  });
  register('initializeAgent', (id) =>
    initializeAgent(store.get<Project>('project', idSchema.parse(id)).path),
  );
  register('branchSession', (raw, rawMessage) => {
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
  });
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
  register('nativeStatus', (raw, id) => accountFor(raw, id).read());
  register('nativeLogin', (raw, region, id) => {
    accounts.idle(idSchema.parse(id ?? raw + '-account'));
    return accountFor(raw, id).start(z.enum(['cn', 'global']).parse(region));
  });
  register('nativeCancel', (raw, id) => accountFor(raw, id).cancel());
  register('nativeOpen', (raw, id) => {
    const state = accountFor(raw, id).state;
    if (state.phase !== 'waiting' || !state.url) throw new Error('授权链接已失效，请重新登录');
    return shell.openExternal(state.url);
  });
  register('nativeCopyCode', (raw, id) => {
    const state = accountFor(raw, id).state;
    if (state.phase !== 'waiting' || !state.userCode) throw new Error('设备码已失效');
    clipboard.writeText(state.userCode);
  });
  register('nativeLogout', async (raw, id) => {
    accounts.idle(idSchema.parse(id ?? raw + '-account'));
    await accountFor(raw, id).logout();
    runtime.changed();
  });
  const requireIdle = () => {
    // Per-run scope remains frozen; dispatch rechecks global revocation.
  };
  register('setCapability', (raw, enabled) => {
    store.setCapability(z.enum(['computer', 'management']).parse(raw), z.boolean().parse(enabled));
    runtime.invalidateNative();
    runtime.changed();
  });
  register('installBuiltinPlugin', () => {
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
  });
  register('runEvents', (id) => runtime.events(idSchema.parse(id)));
  register('enqueue', (input, mode) =>
    runtime.enqueue(runSchema.parse(input), z.enum(['supplement', 'next', 'restart']).parse(mode)),
  );
  register('cancelInput', (id) => runtime.cancelInput(idSchema.parse(id)));
  register('resumeInput', (id) => runtime.resumeInput(idSchema.parse(id)));
  register('editInput', (id, prompt) =>
    runtime.editInput(idSchema.parse(id), z.string().max(100000).parse(prompt)),
  );
  register('deleteSession', async (id) => {
    idSchema.parse(id);
    channels.abort(id);
    await runtime.deleteSession(id);
    feishu.sync();
  });
  register('savePlugin', (raw) => {
    requireIdle();
    const { secret, clearSecret, ...config } = pluginSchema.parse(raw);
    const previous = store.list<PluginConfig>('plugin').find((p) => p.id === config.id);
    const identityChanged =
      !!previous &&
      (pluginAuthIdentity(previous) !== pluginAuthIdentity(config) ||
        previous.command !== config.command ||
        JSON.stringify(previous.args) !== JSON.stringify(config.args));
    if (identityChanged || clearSecret) mcpAuth.logout(config.id);
    const same =
      previous &&
      !identityChanged &&
      !secret &&
      !clearSecret &&
      previous.transport === config.transport &&
      previous.command === config.command &&
      previous.url === config.url &&
      JSON.stringify(previous.args) === JSON.stringify(config.args);
    if (identityChanged) store.saveSecret('plugin_' + config.id, undefined, true);
    store.saveSecret('plugin_' + config.id, secret, clearSecret || config.authMode === 'oauth');
    store.put('plugin', {
      ...config,
      oauthStatus:
        config.authMode === 'oauth' && !identityChanged && !clearSecret
          ? previous?.oauthStatus
          : undefined,
      ...(same ? { catalog: previous.catalog, checkedAt: previous.checkedAt } : {}),
    });
    runtime.invalidateNative();
    runtime.changed();
  });
  register('deletePlugin', (raw) => {
    requireIdle();
    const id = idSchema.parse(raw);
    mcpAuth.logout(id);
    store.remove('plugin', id);
    store.saveSecret('plugin_' + id, undefined, true);
    for (const a of store.list<AgentProfile>('agent'))
      store.put('agent', { ...a, pluginIds: a.pluginIds?.filter((p) => p !== id) });
    runtime.invalidateNative();
    runtime.changed();
  });
  register('testPlugin', async (raw) => {
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
  });
  register('loginPlugin', (raw) => {
    requireIdle();
    return mcpAuth.login(idSchema.parse(raw));
  });
  register('cancelPluginLogin', (raw) => mcpAuth.cancel(idSchema.parse(raw)));
  register('logoutPlugin', (raw) => {
    requireIdle();
    mcpAuth.logout(idSchema.parse(raw));
    runtime.invalidateNative();
  });
  register('useGithubConnector', (rawPlugin, rawConnector) => {
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
  });
  register('importSkill', async () => {
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
  });
  register('saveSkill', (raw) => {
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
  });
  register('deleteSkill', (raw) => {
    requireIdle();
    const id = idSchema.parse(raw);
    store.remove('skill', id);
    for (const a of store.list<AgentProfile>('agent'))
      store.put('agent', { ...a, skillIds: a.skillIds?.filter((s) => s !== id) });
    runtime.invalidateNative();
    runtime.changed();
  });
  const computerStatus = () => ({
    ...computer.status(),
    diagnostic: store.list<any>('computerDiagnostic')[0],
  });
  register('computerStatus', computerStatus);
  register('computerPermission', () => {
    computer.requestPermission();
    return computerStatus();
  });
  let diagnosing = false;
  register('computerSelfTest', async () => {
    if (diagnosing) throw new Error('自检正在进行');
    diagnosing = true;
    try {
      const result = await computerDiagnostic(computer);
      store.put('computerDiagnostic', { id: 'current', ...result });
      return computerStatus();
    } finally {
      diagnosing = false;
    }
  });
  register('emergencyStop', async () => {
    for (const r of runtime.snapshot().runs)
      if (r.status === 'running') await runtime.cancel(r.sessionId);
  });
  register('snapshot', () => runtime.snapshot());
  // Privilege changes are renderer-only controls, not model-callable client commands.
  const permissionSchema = z.enum(['read-only', 'ask', 'full-access']);
  register('setDefaultPermission', (mode, all) => {
    const selected = permissionSchema.parse(mode);
    const applyToAll = z.boolean().parse(all ?? false);
    // The renderer snapshot can lag a just-saved selection. Applying the current
    // default must not restore the previous value while clearing overrides.
    store.setDefaultPermission(applyToAll ? store.defaultPermission() : selected, applyToAll);
    runtime.changed();
  });
  register('setSessionPermission', (id, mode) => {
    store.setSessionPermission(idSchema.parse(id), permissionSchema.nullable().parse(mode));
    runtime.changed();
  });
  register('copyText', (text) => clipboard.writeText(z.string().max(2000000).parse(text)));
  register('clientMethods', () => clientCommands.describe());
  register('openModule', (view) =>
    emit({
      type: 'navigate',
      view: z
        .enum([
          'workspace',
          'providers',
          'agents',
          'activity',
          'settings',
          'extensions',
          'projects',
        ])
        .parse(view),
    }),
  );
  register('messages', (id, raw) => {
    const options = z
      .object({ before: idSchema.optional(), limit: z.number().int().min(1).max(500).optional() })
      .parse(raw ?? {});
    return store.messagesPage(idSchema.parse(id), options.before, options.limit);
  });
  register('readMessage', (sessionId, messageId, raw) => {
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
  });
  register('saveProvider', (raw) => {
    const input = providerSchema.parse(raw);
    const pending = pendingImports.get(input.id);
    const result = store.saveProvider({ ...input, secret: input.secret || pending?.secret });
    pendingImports.delete(input.id);
    runtime.changed();
    return result;
  });
  register('deleteProvider', (raw) => {
    const id = idSchema.parse(raw);
    if (runtime.snapshot().runs.some((r) => r.providerId === id && r.status === 'running'))
      throw new Error('此连接正在执行任务');
    store.deleteProvider(id);
    accounts.forget(id);
    runtime.changed();
  });
  register('testProvider', async (raw, model) => {
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
  });
  register('models', async (raw) => {
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
  });
  register('saveAgent', (raw) => {
    const a = agentSchema.parse(raw);
    if (a.providerId) store.get('provider', a.providerId);
    for (const id of a.pluginIds ?? []) store.get('plugin', id);
    for (const id of a.skillIds ?? []) store.get('skill', id);
    store.put('agent', a);
    runtime.changed();
    return a;
  });
  register('deleteAgent', (raw) => {
    const id = idSchema.parse(raw);
    store.remove('agent', id);
    for (const s of store.list<Session>('session'))
      if (s.agentId === id) store.put('session', { ...s, agentId: '' });
    runtime.changed();
  });
  register('addProject', async () => {
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
  });
  register('createSession', (id) => {
    if (id && store.get<Project>('project', idSchema.parse(id)).removed)
      throw new Error('工作树已移除，不能创建新会话');
    const s = store.createSession(idSchema.nullish().parse(id) ?? null);
    runtime.changed();
    return s;
  });
  register('updateSession', (raw, patch) => {
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
  });
  register('run', (input) => runtime.start(runSchema.parse(input)));
  register('team', (input, ids) =>
    runtime.team(runSchema.parse(input), z.array(idSchema).min(1).max(3).parse(ids)),
  );
  register('cancel', (id) => runtime.cancel(idSchema.parse(id)));
  register('approve', (id, allow) => runtime.approve(idSchema.parse(id), z.boolean().parse(allow)));
  register('listFiles', (id, relative) =>
    files(
      store.get<Project>('project', idSchema.parse(id)).path,
      z.string().max(1000).parse(relative),
    ),
  );
  register('readFile', (id, relative) =>
    read(
      store.get<Project>('project', idSchema.parse(id)).path,
      z.string().max(1000).parse(relative),
    ),
  );
  register('diff', async (id) => {
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
  });
  register('importCCSwitch', async () => {
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
  });
  register('exportSession', async (raw) => {
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
  });
  const codexFor = (id?: unknown) =>
    accounts.codex(id === undefined ? undefined : idSchema.parse(id));
  register('codexStatus', (id) => codexFor(id).read());
  register('codexLogin', (method, id) => {
    accounts.idle(idSchema.parse(id ?? 'openai-codex'));
    return codexFor(id).start(z.enum(['browser', 'device']).parse(method ?? 'browser'));
  });
  register('codexLoginRetry', (method, id) => {
    accounts.idle(idSchema.parse(id ?? 'openai-codex'));
    return codexFor(id).restart(z.enum(['browser', 'device']).parse(method));
  });
  register('codexLoginCancel', (id) => codexFor(id).cancel());
  register('codexLoginOpen', (id) => codexFor(id).openPage());
  register('codexLoginCopyCode', (id) => clipboard.writeText(codexFor(id).code()));
  register('codexLogout', async (id) => {
    accounts.idle(idSchema.parse(id ?? 'openai-codex'));
    await codexFor(id).logout();
    runtime.changed();
  });
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
