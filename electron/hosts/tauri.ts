import { EventEmitter } from 'node:events';
import { tauriDesktop } from './tauri-desktop';
import { decodeArguments } from '../../src/shared/rpc';
import { createInterface } from 'node:readline';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionApplication } from '../application/execution-application';
import type { ApplicationHost } from '../application/host';
import { accountServices } from '../application/account-services';
import { accountsPlugin } from '../application/features/accounts';
import { providersPlugin } from '../application/features/providers';
import { localSecretCodec } from '../services/storage/local-secret-codec';
import { writeLocalFile } from '../services/storage/file-transfer';
import { setServiceTransport } from '../services/network/service-network';
import { loginUrl } from '../services/accounts/codex-auth';
import type { Provider } from '../../src/shared/types';
import { redact } from '../services/storage/validation';
import { nodeNetwork } from './node-network';

// stdout is a private framed transport. Dependency logs cannot become protocol messages.
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
console.log = (...args) => console.error(...args);
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
let sequence = 0;
let parentClosed = false;
function native<T = any>(method: string, ...args: unknown[]): Promise<T> {
  if (parentClosed) return Promise.reject(new Error('原生宿主已断开'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'host', id, method, args });
  });
}
const hostEvents = new EventEmitter();
const desktop = tauriDesktop(native, hostEvents);
const dataDir = process.argv[2];
if (!dataDir || !path.isAbsolute(dataDir))
  throw new Error('An absolute preview profile is required');
const network = nodeNetwork();
const dialogs: ApplicationHost['dialogs'] = {
  showOpenDialog: (options) => native('openDialog', options),
  showSaveDialog: (options) => native('saveDialog', options),
};
const openExternal = (url: string) => native<void>('openExternal', url);
const host: ApplicationHost = {
  version: process.argv[3] ?? '1.0.4',
  dialogs,
  computer: desktop.computer,
  documents: {
    async chooseFiles(title) {
      const result = await dialogs.showOpenDialog({
        title,
        properties: ['openFile', 'multiSelections'],
      });
      return result.canceled ? [] : result.filePaths;
    },
    async readImport(file) {
      if ((await stat(file)).size > 25 * 1024 * 1024) throw new Error('超过 25 MB');
      const bytes = await readFile(file);
      if (bytes.length > 25 * 1024 * 1024) throw new Error('超过 25 MB');
      return bytes;
    },
    async saveCopy(bytes, title, defaultPath) {
      const result = await dialogs.showSaveDialog({ title, defaultPath });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, bytes);
      return result.filePath;
    },
    writeTo: writeLocalFile,
    openPath: (file) => native<void>('openPath', file),
    openExternal,
  },
  writeClipboard: (text) => native<void>('clipboard', text),
  restart: () => native<void>('restart'),
  setTheme: (theme) => native<void>('theme', theme),
};
const app = new ExecutionApplication(
  {
    dataDir,
    bundleDir: __dirname,
    host,
    computer: desktop.computer.controller,
    createSecretCodec: () => localSecretCodec(dataDir),
    modelTransport: network.transport,
    emit: (event) => send({ type: 'event', event }),
  },
  {
    services: (kernel) => [
      ...desktop.services(kernel),
      ...accountServices(kernel, (store, resolve) => ({
        async open(url, id) {
          loginUrl(url);
          const p = store.get<Provider>('provider', id);
          const selected = await resolve(p.network);
          if (!selected || selected.mode === 'inherit') return openExternal(url);
          if (selected.mode === 'direct')
            throw new Error('Tauri 预览的浏览器直连隔离尚未验证，请使用设备码登录或 Electron。');
          await native('authOpen', id, url, selected);
        },
        close(id) {
          void native('authClose', id).catch(() => {});
        },
        async test(id) {
          const p = store.get<Provider>('provider', id);
          const selected = await resolve(p.network);
          const transport = await network.transport(selected);
          const started = Date.now();
          try {
            const response = await transport(
              'https://auth.openai.com/.well-known/openid-configuration',
              { signal: AbortSignal.timeout(15000), redirect: 'error' },
            );
            await response.body?.cancel();
            if (!response.ok) throw new Error(`授权服务返回 HTTP ${response.status}`);
            return `账号网络可达（${Date.now() - started} ms）。未执行登录或模型推理。`;
          } catch (error: any) {
            throw new Error('账号网络测试失败：' + error.message);
          }
        },
        dispose() {
          void native('authCloseAll').catch(() => {});
        },
      })),
    ],
    features: [accountsPlugin, providersPlugin, ...desktop.features],
  },
);
let closing: Promise<void> | undefined;
async function stop() {
  closing ??= (async () => {
    await app.stop();
    setServiceTransport();
    await network.dispose();
  })();
  return closing;
}
hostEvents.on('emergencyStop', async () => {
  try {
    await app.client.invoke('emergencyStop');
  } catch (error) {
    console.error(error);
  }
});
const ready = (async () => {
  await desktop.prepare();
  setServiceTransport(await network.transport());
  await app.start();
  if (!process.env.TONGZHOU_DISABLE_UPDATES) app.kernel.context.tzUpdates.start();
  send({ type: 'ready' });
})();
ready.catch((error) => {
  send({ type: 'fatal', error: redact(String(error)) });
  void stop().finally(() => process.exit(1));
});
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  void (async () => {
    let message: any;
    try {
      message = JSON.parse(line);
      if (message.type === 'host_result') {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.ok ? request.resolve(message.value) : request.reject(new Error(message.error));
        return;
      }
      if (message.type === 'host_event') {
        hostEvents.emit(message.name, message.payload);
        return;
      }
      if (message.type === 'shutdown') {
        await ready.catch(() => {});
        await stop();
        send({ type: 'result', id: message.id, ok: true, value: null });
        input.close();
        process.exit(0);
      }
      if (
        message.type !== 'invoke' ||
        !Number.isSafeInteger(message.id) ||
        typeof message.method !== 'string' ||
        !Array.isArray(message.args)
      )
        throw new Error('无效的进程请求');
      await ready;
      const value = await app.client.invoke(
        message.method,
        ...decodeArguments(message.args, message.undefinedArgs),
      );
      send({ type: 'result', id: message.id, ok: true, value: value ?? null });
    } catch (error: any) {
      send({
        type: 'result',
        id: message?.id,
        ok: false,
        error: redact(error.message ?? String(error)),
      });
    }
  })();
});
input.on('close', () => {
  parentClosed = true;
  for (const request of pending.values()) request.reject(new Error('原生宿主已断开'));
  pending.clear();
  if (!closing) void stop().finally(() => process.exit(0));
});
