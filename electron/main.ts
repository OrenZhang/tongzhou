import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  clipboard,
  globalShortcut,
} from 'electron';
import { NativeAccount, nativeEngine } from './native-engine';
import { CodexAuth } from './codex-auth';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { Runtime } from './runtime';
import { DesktopComputer } from './computer';
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
let auth: CodexAuth;
const computer = new DesktopComputer();
const nativeAccounts = {} as Record<'kimi' | 'minimax', NativeAccount>;
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
  runtime = new Runtime(store, dataDir, emit, computer);
  auth = new CodexAuth(
    runtime.authClient,
    (url) => shell.openExternal(url),
    (state) => emit({ type: 'codex-auth', state }),
    async () => {
      const result = await runtime.authClient.request('model/list', { includeHidden: false });
      const models = result.data
        .map((m: any) => m.model ?? m.id)
        .filter((m: unknown) => typeof m === 'string');
      for (const p of store.list<Provider>('provider'))
        if (p.protocol === 'codex') store.put('provider', { ...p, models });
      runtime.changed();
    },
  );
  for (const engine of ['kimi', 'minimax'] as const) {
    const providerId = `${engine}-account`;
    if (!store.list<Provider>('provider').some((p) => p.id === providerId))
      store.saveProvider({
        id: providerId,
        name: engine === 'kimi' ? 'Kimi · 账号授权' : 'MiniMax · 账号授权',
        protocol: engine,
        auth: 'native',
        baseUrl: '',
        models: [],
        maxOutputTokens: 8192,
        contextChars: 160000,
      });
    nativeAccounts[engine] = new NativeAccount(
      engine,
      path.join(dataDir, 'engines', engine),
      (state) => emit({ type: 'native-auth', state }),
      (catalog) => {
        for (const p of store.list<Provider>('provider'))
          if (p.protocol === engine)
            store.put('provider', {
              ...p,
              models: catalog.models,
              modelLabels: catalog.modelLabels,
            });
        runtime.changed();
      },
    );
  }
  const accountFor = (raw: unknown) => nativeAccounts[z.enum(['kimi', 'minimax']).parse(raw)];
  const assertNativeIdle = (engine: unknown) => {
    if (
      runtime.snapshot().runs.some((r) => r.config?.protocol === engine && r.status === 'running')
    )
      throw new Error('请先停止该引擎的任务，再切换账号');
    runtime.invalidateNative(z.enum(['kimi', 'minimax']).parse(engine));
  };
  register('nativeStatus', (raw) => accountFor(raw).read());
  register('nativeLogin', (raw, region) => {
    assertNativeIdle(raw);
    return accountFor(raw).start(z.enum(['cn', 'global']).parse(region));
  });
  register('nativeCancel', (raw) => accountFor(raw).cancel());
  register('nativeOpen', (raw) => {
    const state = accountFor(raw).state;
    if (state.phase !== 'waiting' || !state.url) throw new Error('授权链接已失效，请重新登录');
    return shell.openExternal(state.url);
  });
  register('nativeCopyCode', (raw) => {
    const state = accountFor(raw).state;
    if (state.phase !== 'waiting' || !state.userCode) throw new Error('设备码已失效');
    clipboard.writeText(state.userCode);
  });
  register('nativeLogout', async (raw) => {
    assertNativeIdle(raw);
    await accountFor(raw).logout();
    runtime.changed();
  });
  const requireIdle = () => {
    if (runtime.snapshot().runs.some((r) => r.status === 'running'))
      throw new Error('请先停止正在运行的任务，再修改插件或 Skill');
  };
  register('savePlugin', (raw) => {
    requireIdle();
    const { secret, clearSecret, ...config } = pluginSchema.parse(raw);
    store.saveSecret('plugin_' + config.id, secret, clearSecret);
    store.put('plugin', config);
    runtime.invalidateNative();
    runtime.changed();
  });
  register('deletePlugin', (raw) => {
    requireIdle();
    const id = idSchema.parse(raw);
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
    const c = new PluginConnection(p, store.secret('plugin_' + p.id));
    try {
      const signal = AbortSignal.timeout(30000);
      await c.connect(signal);
      return (await c.tools(signal)).map((t) => ({
        name: t.name,
        description: t.description ?? '',
      }));
    } finally {
      await c.close();
    }
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
  register('computerStatus', () => computer.status());
  register('computerPermission', () => computer.requestPermission());
  register('emergencyStop', async () => {
    for (const r of runtime.snapshot().runs)
      if (r.status === 'running') await runtime.cancel(r.sessionId);
  });
  register('snapshot', () => runtime.snapshot());
  register('messages', (id) => store.messages(idSchema.parse(id)));
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
    runtime.changed();
  });
  register('testProvider', async (raw, model) => {
    const p = store.get<Provider>('provider', idSchema.parse(raw));
    const selected = z.string().min(1).max(200).parse(model);
    if (nativeEngine(p.protocol)) {
      const catalog = await nativeAccounts[p.protocol].catalog();
      store.put('provider', { ...p, models: catalog.models, modelLabels: catalog.modelLabels });
      runtime.changed();
      return '账号已通过官方引擎验证，模型列表已同步；实际调用权限以账号套餐为准。';
    }
    if (p.protocol === 'codex') {
      await runtime.authClient.start();
      const a = await runtime.authClient.request('account/read', {});
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
      const catalog = await nativeAccounts[p.protocol].catalog();
      store.put('provider', { ...p, models: catalog.models, modelLabels: catalog.modelLabels });
      runtime.changed();
      return catalog.models;
    }
    if (p.protocol === 'codex') {
      await runtime.authClient.start();
      const result = await runtime.authClient.request('model/list', { includeHidden: false });
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
    if (['builder', 'reviewer', 'architect'].includes(id))
      throw new Error('内置 Agent 可以编辑，但不能删除');
    store.remove('agent', id);
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
  register('codexStatus', () => auth.read());
  register('codexLogin', async (method) => {
    if (
      runtime.snapshot().runs.some((r) => r.config?.protocol === 'codex' && r.status === 'running')
    )
      throw new Error('请先停止 Codex 任务，再切换登录账号');
    return auth.start(z.enum(['browser', 'device']).parse(method ?? 'browser'));
  });
  register('codexLoginRetry', async (method) => {
    if (
      runtime.snapshot().runs.some((r) => r.config?.protocol === 'codex' && r.status === 'running')
    )
      throw new Error('请先停止 Codex 任务，再重新授权');
    return auth.restart(z.enum(['browser', 'device']).parse(method));
  });
  register('codexLoginCancel', () => auth.cancel());
  register('codexLoginOpen', () => auth.openPage());
  register('codexLoginCopyCode', () => clipboard.writeText(auth.code()));
  register('codexLogout', async () => {
    if (
      runtime.snapshot().runs.some((r) => r.config?.protocol === 'codex' && r.status === 'running')
    )
      throw new Error('请先停止 Codex 任务');
    await auth.logout();
    runtime.changed();
  });
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    title: '同舟 Tongzhou',
    icon: path.join(__dirname, '../build/icon.png'),
    backgroundColor: '#f8f9fb',
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
    auth.dispose();
    for (const account of Object.values(nativeAccounts)) account.dispose();
    runtime.stop();
    void runtime.waitForIdle().finally(() => {
      store.close();
      app.quit();
    });
  });
}
