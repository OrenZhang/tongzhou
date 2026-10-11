import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { macLidDirectory } from './macos-lid-script';

export class LidProcess {
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private exitError?: string;
  private stopping = false;
  private token?: string;
  private starting?: Promise<void>;

  constructor(
    private nodePath: string,
    private bundleDir: string,
    private dataDir: string,
    private failed: (message: string) => void,
    private platform = process.platform,
  ) {}

  async recover() {
    if (!['win32', 'darwin'].includes(this.platform)) return;
    const journal =
      this.platform === 'darwin'
        ? macLidDirectory + '/original'
        : path.join(this.dataDir, 'lid-power-backup.json');
    if (!existsSync(journal) || readFileSync(journal, 'utf8').trim() === '[]') return;
    await this.start(true);
    await this.setEnabled(false);
  }

  async setEnabled(enabled: boolean, interactive = false) {
    if (enabled) {
      if (!this.child) this.starting = this.start(false);
      await this.starting;
    } else if (this.child) {
      this.stopping = true;
      if (this.child.connected) this.child.send('stop');
      await this.exited;
      if (this.platform === 'darwin' && this.token) await this.waitForMacRestore(this.token);
      if (this.exitError) throw new Error(this.exitError);
    } else if (this.platform === 'win32' || interactive) {
      await this.recover();
    }
  }

  private start(recover: boolean) {
    this.exitError = undefined;
    this.stopping = false;
    this.token = undefined;
    const child = fork(
      path
        .join(
          this.bundleDir,
          this.platform === 'darwin' ? 'macos-lid-host.cjs' : 'windows-lid-host.cjs',
        )
        .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
      [path.join(this.dataDir, 'lid-power-backup.json'), recover ? 'recover' : 'enable'],
      {
        execPath: this.nodePath,
        execArgv: [],
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    this.child = child;
    this.exited = new Promise((resolve) =>
      child.once('exit', () => {
        if (this.child === child) this.child = undefined;
        resolve();
      }),
    );
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          reject(new Error('合盖设置响应超时，请重试'));
          // Disconnect rather than kill, allowing the helper to restore its journal.
          if (child.connected) child.disconnect();
        },
        this.platform === 'darwin' ? 140000 : 45000,
      );
      child.on('error', () => {
        clearTimeout(timeout);
        this.child = undefined;
        reject(new Error('无法启动合盖电源管理助手'));
      });
      child.on('message', (message: any) => {
        if (message?.type === 'session') this.token = message.token;
        else if (message?.type === 'ready') {
          clearTimeout(timeout);
          resolve();
        } else if (message?.type === 'error') {
          clearTimeout(timeout);
          this.exitError = String(message.message);
          this.failed(this.exitError);
          reject(new Error(this.exitError));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0 || !this.stopping) {
          this.exitError ||= '合盖电源管理助手意外退出，请重试以恢复原设置';
          this.failed(this.exitError);
        }
        reject(new Error(this.exitError || '合盖电源管理助手已退出'));
      });
    });
  }

  private async waitForMacRestore(token: string) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const file = macLidDirectory + '/status-' + token;
      const phase = existsSync(file) ? readFileSync(file, 'utf8').trim().split(' ')[1] : '';
      if (phase === 'restored') return;
      if (!phase && !existsSync(macLidDirectory + '/original')) return;
      if (phase === 'restore-error') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('macOS 尚未确认恢复原睡眠设置，请点击重试并完成管理员授权');
  }
}
