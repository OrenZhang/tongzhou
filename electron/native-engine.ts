import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { minimalEnv } from './workspace';
import { configureNativeTools } from './native-policy';
import type { NativeAuthState, NativeEngine } from '../src/shared/types';

const definitions = {
  kimi: { package: '@moonshot-ai/kimi-code', entry: 'dist/main.mjs', method: 'login' },
  minimax: { package: '@minimax-ai/code', entry: 'cli.js', method: 'minimax-code-login' },
};
export const nativeEngine = (protocol: string): protocol is NativeEngine =>
  protocol === 'kimi' || protocol === 'minimax';

export function launchEngine(kind: NativeEngine, home: string, args: string[]) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (args[0] === 'acp') configureNativeTools(kind, home);
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const root = path
    .dirname(
      require.resolve(`${definitions[kind].package}/package.json`, {
        paths: [__dirname, process.cwd()],
      }),
    )
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const entry = path.join(root, definitions[kind].entry);
  if (!existsSync(entry)) throw new Error(`${kind} 内置引擎缺失，请重新安装同舟`);
  const nodeRoot = path
    .dirname(require.resolve('node/package.json', { paths: [__dirname, process.cwd()] }))
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const executable = path.join(nodeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  if (!existsSync(executable)) throw new Error('内置 Node 运行时缺失，请重新安装同舟');
  return spawn(executable, [entry, ...args], {
    cwd: home,
    windowsHide: true,
    shell: false,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    env: {
      ...minimalEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      NO_COLOR: '1',
      KIMI_CODE_HOME: home,
      MINIMAX_DATA_DIR: home,
      MAVIS_DATA_DIR: home,
    },
  });
}
export function stopEngine(child?: ChildProcessWithoutNullStreams) {
  if (!child?.pid || child.exitCode !== null) return;
  child.stdin.end();
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => child.kill());
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** ACP over stdio. No credential files or access tokens cross this interface. */
export class NativeClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  constructor(
    readonly kind: NativeEngine,
    readonly home: string,
  ) {
    super();
  }
  get connected() {
    return !!this.child?.stdin.writable && this.child.exitCode === null;
  }
  async start(): Promise<any> {
    const bootstrap = this.kind === 'minimax' && !existsSync(path.join(this.home, 'config.yaml'));
    this.child = launchEngine(this.kind, this.home, ['acp']);
    const child = this.child;
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (part: string) => {
      buffer += part;
      if (buffer.length > 8_000_000) {
        this.stop();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method) this.emit(msg.id === undefined ? 'notification' : 'request', msg);
        else {
          const pending = this.pending.get(msg.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.error)
            pending.reject(
              Object.assign(new Error(msg.error.message || '引擎请求失败'), {
                code: msg.error.code,
              }),
            );
          else pending.resolve(msg.result ?? {});
        }
      }
    });
    // Drain diagnostic output; it can contain private auth details, so do not forward it.
    this.child.stderr.resume();
    this.child.on('error', () => {
      if (this.child === child) this.fail(new Error(`${this.kind} 引擎启动失败`));
    });
    this.child.on('exit', () => {
      if (this.child === child) this.fail(new Error(`${this.kind} 引擎已退出`));
    });
    const initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'tongzhou', version: '0.5.2' },
      clientCapabilities: {
        auth: { terminal: true },
        _meta: { 'terminal-auth': true },
        fs: {},
        terminal: false,
      },
    });
    if (bootstrap) {
      this.stop();
      if (!existsSync(path.join(this.home, 'config.yaml')))
        throw new Error('MiniMax 未创建账号配置');
      return this.start();
    }
    return initialized;
  }
  async authenticate() {
    try {
      return await this.request('authenticate', { methodId: definitions[this.kind].method });
    } catch (error: any) {
      if (error.code === -32000)
        throw Object.assign(
          new Error(
            `尚未登录 ${this.kind === 'kimi' ? 'Kimi' : 'MiniMax'}，请在设置与关于中完成账号授权。`,
          ),
          { code: -32000 },
        );
      throw error;
    }
  }
  request(method: string, params: any, timeout = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('引擎尚未连接'));
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.kind} ${method} 请求超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  reply(id: string | number, result: any) {
    this.send({ id, result });
  }
  reject(id: string | number) {
    this.send({
      id,
      error: { code: -32601, message: 'Unsupported interaction. Ask the user in chat.' },
    });
  }
  private send(value: any) {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  stop() {
    const child = this.child;
    this.child = undefined;
    stopEngine(child);
    this.fail(new Error('引擎已停止'));
  }
}

export function modelCatalog(session: any): {
  models: string[];
  modelLabels: Record<string, string>;
  optionId?: string;
} {
  const option = session.configOptions?.find(
    (o: any) => o.category === 'model' || o.id === 'model',
  );
  const flatten = (options: any[]): any[] =>
    options.flatMap((o) => (o.options ? flatten(o.options) : [o]));
  const entries = option
    ? flatten(option.options ?? []).map((o) => [o.value, o.name])
    : (session.models?.availableModels ?? []).map((o: any) => [o.modelId, o.name]);
  const modelLabels = Object.fromEntries(
    entries
      .filter(
        ([id, name]: any[]) =>
          typeof id === 'string' && id.length <= 200 && typeof name === 'string',
      )
      .slice(0, 200),
  );
  return { models: Object.keys(modelLabels), modelLabels, optionId: option?.id };
}

export function loginDetails(
  kind: NativeEngine,
  output: string,
): { url?: string; userCode?: string } {
  const hosts =
    kind === 'kimi'
      ? ['auth.kimi.com', 'auth.kimi.ai', 'www.kimi.com', 'www.kimi.ai', 'kimi.com', 'kimi.ai']
      : [
          'account.minimax.cn',
          'account.minimax.io',
          'agent.minimax.cn',
          'agent.minimax.io',
          'agent.minimaxi.com',
          'platform.minimaxi.com',
          'platform.minimax.cn',
          'platform.minimax.io',
          'www.minimax.io',
          'www.minimaxi.com',
        ];
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  let url: string | undefined;
  for (const candidate of clean.match(/https:\/\/[^\s<>"\x1b]+/g) ?? []) {
    try {
      const u = new URL(candidate);
      if (!u.username && !u.password && (!u.port || u.port === '443') && hosts.includes(u.hostname))
        url = u.href;
    } catch {}
  }
  const userCode = clean.match(/(?:enter code|^Code):\s*([A-Z0-9-]{4,32})\b/im)?.[1];
  return { url, userCode };
}

export class NativeAccount {
  state: NativeAuthState;
  private child?: ChildProcessWithoutNullStreams;
  private timer?: NodeJS.Timeout;
  private epoch = 0;
  private disposed = false;
  private signingOut = false;
  private readers = new Set<NativeClient>();
  constructor(
    readonly kind: NativeEngine,
    readonly home: string,
    private publish: (state: NativeAuthState) => void,
    private signedIn: (catalog: ReturnType<typeof modelCatalog>) => void,
  ) {
    this.state = { engine: kind, phase: 'idle', authenticated: false };
  }
  private set(patch: Partial<NativeAuthState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.publish(this.state);
    return this.state;
  }
  async catalog() {
    const client = new NativeClient(this.kind, this.home);
    this.readers.add(client);
    client.on('request', (r) => client.reject(r.id));
    try {
      await client.start();
      await client.authenticate();
      const cwd = path.join(this.home, 'model-probe');
      mkdirSync(cwd, { recursive: true });
      const session = await client.request('session/new', { cwd, mcpServers: [] });
      return modelCatalog(session);
    } finally {
      client.stop();
      this.readers.delete(client);
    }
  }
  async read() {
    if (this.signingOut) return this.state;
    if (['starting', 'waiting', 'checking'].includes(this.state.phase)) return this.state;
    const epoch = this.epoch;
    const client = new NativeClient(this.kind, this.home);
    this.readers.add(client);
    client.on('request', (r) => client.reject(r.id));
    try {
      await client.start();
      await client.authenticate();
      if (epoch === this.epoch) this.set({ authenticated: true, error: undefined });
    } catch (e: any) {
      if (epoch === this.epoch)
        this.set({
          authenticated: false,
          error:
            e.code === -32000 || /auth|login|sign.in/i.test(e.message)
              ? undefined
              : '引擎暂不可用，请重试或重新安装同舟。',
        });
    } finally {
      client.stop();
      this.readers.delete(client);
    }
    return this.state;
  }
  start(region: 'cn' | 'global') {
    if (this.signingOut) throw new Error('正在退出账号，请稍后重试');
    this.cancel(false);
    const epoch = this.epoch;
    this.set({ phase: 'starting', region, url: undefined, userCode: undefined, error: undefined });
    try {
      const args = [
        'login',
        '--region',
        this.kind === 'kimi' && region === 'cn' ? 'mainland-cn' : region,
      ];
      if (this.kind === 'minimax') args.push('--no-browser');
      const child = (this.child = launchEngine(this.kind, this.home, args));
      let output = '';
      const append = (b: Buffer) => {
        if (epoch !== this.epoch) return;
        output = (output + String(b)).slice(-16000);
        const details = loginDetails(this.kind, output);
        if (details.url) this.set({ phase: 'waiting', ...details });
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', () => {
        if (epoch === this.epoch) this.finishError('登录进程启动失败，请重新安装同舟。');
      });
      child.on('close', async (code) => {
        if (epoch !== this.epoch) return;
        this.child = undefined;
        clearTimeout(this.timer);
        if (code !== 0) {
          this.finishError('授权未完成或已过期，请检查网络后重试。切换地区前请先退出登录。');
          return;
        }
        this.set({ phase: 'checking', url: undefined, userCode: undefined });
        try {
          const catalog = await this.catalog();
          if (epoch !== this.epoch) return;
          this.signedIn(catalog);
          this.set({ phase: 'success', authenticated: true, error: undefined });
        } catch {
          if (epoch === this.epoch)
            this.finishError('授权回调已结束，但账号或模型未能验证，请刷新状态后重试。');
        }
      });
      this.timer = setTimeout(
        () => {
          if (epoch === this.epoch) {
            this.cancel(false);
            this.finishError('授权等待超时，请重新登录。');
          }
        },
        10 * 60 * 1000,
      );
    } catch {
      this.finishError('内置引擎启动失败，请重新安装同舟。');
    }
    return this.state;
  }
  private finishError(error: string) {
    clearTimeout(this.timer);
    this.set({ phase: 'error', url: undefined, userCode: undefined, error });
  }
  cancel(publish = true) {
    ++this.epoch;
    clearTimeout(this.timer);
    stopEngine(this.child);
    this.child = undefined;
    for (const reader of this.readers) reader.stop();
    if (publish)
      this.set({ phase: 'cancelled', url: undefined, userCode: undefined, error: undefined });
  }
  async logout() {
    if (this.signingOut) throw new Error('正在退出账号，请稍后重试');
    this.signingOut = true;
    try {
      this.cancel(false);
      if (this.kind === 'kimi') {
        const client = new NativeClient(this.kind, this.home);
        this.readers.add(client);
        try {
          await client.start();
          await client.request('logout', {});
        } finally {
          client.stop();
          this.readers.delete(client);
        }
      } else {
        const child = launchEngine(this.kind, this.home, ['logout', '--no-browser']);
        this.child = child;
        child.stdout.resume();
        child.stderr.resume();
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              stopEngine(child);
              reject(new Error('退出登录超时'));
            }, 60000);
            child.once('error', () => {
              clearTimeout(timer);
              reject(new Error('退出登录失败'));
            });
            child.once('close', (code) => {
              clearTimeout(timer);
              code === 0 ? resolve() : reject(new Error('退出登录失败'));
            });
          });
        } finally {
          this.child = undefined;
        }
      }
      this.set({
        phase: 'idle',
        authenticated: false,
        error: undefined,
        url: undefined,
        userCode: undefined,
      });
    } finally {
      this.signingOut = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.cancel(false);
  }
}
