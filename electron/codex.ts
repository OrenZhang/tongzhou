import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { minimalEnv } from './workspace';

export function codexBinary(): string {
  if (process.env.TONGZHOU_CODEX_PATH && existsSync(process.env.TONGZHOU_CODEX_PATH))
    return process.env.TONGZHOU_CODEX_PATH;
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const triple =
    process.platform === 'win32'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
      : process.platform === 'darwin'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
        : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
  try {
    // Resolve from bundled entry point first; process.cwd() may be unrelated in packaged apps.
    const root = path.dirname(
      require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`, {
        paths: [__dirname, process.cwd()],
      }),
    );
    const binary = path
      .join(root, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    if (existsSync(binary)) return binary;
  } catch {}
  throw new Error('内置 Codex 引擎缺失，请重新安装同舟或安装项目的可选依赖');
}
export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private lastError = '';
  constructor(readonly home: string) {
    super();
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.initialize().catch((e) => {
      this.starting = undefined;
      this.stop();
      throw e;
    });
    return this.starting;
  }
  private async initialize() {
    mkdirSync(this.home, { recursive: true });
    const binary = codexBinary();
    const env: NodeJS.ProcessEnv = { ...minimalEnv(), CODEX_HOME: this.home };
    // Windows binaries include rg and sandbox helpers alongside the CLI distribution.
    env.PATH = [
      path.dirname(binary),
      path.join(path.dirname(binary), '..', 'codex-path'),
      env.PATH ?? env.Path ?? '',
    ].join(path.delimiter);
    delete env.Path;
    this.child = spawn(
      binary,
      [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'cli_auth_credentials_store="keyring"',
        '-c',
        'analytics.enabled=false',
      ],
      {
        env,
        windowsHide: true,
        stdio: 'pipe',
        shell: false,
        detached: process.platform !== 'win32',
      },
    );
    const child = this.child;
    child.on('error', (error) => {
      if (this.child === child) this.fail(error);
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.starting = undefined;
      this.child = undefined;
      this.fail(new Error(this.lastError || 'Codex 进程已退出'));
    });
    child.stderr.on('data', (b) => {
      if (this.child !== child) return;
      this.lastError = String(b).slice(-1000);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && !msg.method) {
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          }
        } else if (msg.method && msg.id !== undefined) this.emit('request', msg);
        else if (msg.method) this.emit('notification', msg);
      } catch {}
    });
    await this.request('initialize', {
      clientInfo: { name: 'tongzhou', title: '同舟 Tongzhou', version: '0.2.0' },
    });
    this.notify('initialized', {});
  }
  request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) {
        reject(new Error('Codex 尚未连接'));
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 请求超时`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  notify(method: string, params: any) {
    this.child?.stdin.write(JSON.stringify({ method, params }) + '\n');
  }
  reply(id: string | number, result: any) {
    this.child?.stdin.write(JSON.stringify({ id, result }) + '\n');
  }
  reject(id: string | number, message: string) {
    this.child?.stdin.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n');
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
  }
  stop() {
    const child = this.child;
    if (child?.pid) {
      child.stdin.end();
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }
    this.child = undefined;
    this.starting = undefined;
    this.fail(new Error('Codex 已停止'));
  }
}
