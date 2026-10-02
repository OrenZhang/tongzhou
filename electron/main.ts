import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { Runtime } from './runtime';
import { agentSchema, idSchema, providerSchema, redact, runSchema } from './validation';
import { complete, listModels } from './providers';
import { command, files, read } from './workspace';
import { importCCSwitch } from './cc-switch';
import type {
  AgentProfile,
  AppEvent,
  Project,
  Provider,
  ProviderInput,
  Session,
} from '../src/shared/types';

if (process.env.TONGZHOU_USER_DATA) app.setPath('userData', process.env.TONGZHOU_USER_DATA);
app.setName('Tongzhou');
let window: BrowserWindow | undefined;
let store: Store;
let runtime: Runtime;
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
  runtime = new Runtime(store, dataDir, emit);
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
      })
      .parse(patch);
    if (runtime.isActive(id) && update.archived) throw new Error('请先停止执行');
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
  register('codexStatus', async () => {
    try {
      await runtime.authClient.start();
      const result = await runtime.authClient.request('account/read', {});
      return { available: true, account: result.account?.email ?? result.account?.type ?? '' };
    } catch (e: any) {
      return { available: false, account: '', error: redact(e.message) };
    }
  });
  register('codexLogin', async () => {
    await runtime.authClient.start();
    const result = await runtime.authClient.request('account/login/start', { type: 'chatgpt' });
    const url = new URL(result.authUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com')
      throw new Error('Codex 返回了不受信任的登录地址');
    await shell.openExternal(url.href);
    return '已在系统浏览器打开 OpenAI 登录。完成后点击刷新状态。';
  });
  register('codexLogout', async () => {
    if (
      runtime.snapshot().runs.some((r) => r.config?.protocol === 'codex' && r.status === 'running')
    )
      throw new Error('请先停止 Codex 任务');
    await runtime.authClient.start();
    await runtime.authClient.request('account/logout', {});
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
    runtime.stop();
    void runtime.waitForIdle().finally(() => {
      store.close();
      app.quit();
    });
  });
}
