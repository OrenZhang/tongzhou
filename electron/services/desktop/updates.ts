import type { UpdateState } from '../../../src/shared/updates';

export interface UpdateDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(name: string, handler: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent?: boolean, restart?: boolean): void;
}

/** Only the main process chooses the trusted publisher and performs installation. */
export class Updates {
  private state: UpdateState;
  private checking?: Promise<UpdateState>;
  private installing?: Promise<UpdateState>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private driver: UpdateDriver,
    version: string,
    private packaged: boolean,
    automaticInstall: boolean,
    private busy: () => boolean,
    private changed: (state: UpdateState) => void,
  ) {
    this.state = {
      phase: packaged ? 'idle' : 'unsupported',
      currentVersion: version,
      automaticInstall,
      message: packaged ? undefined : '开发预览不执行自动更新，请使用正式安装版。',
    };
    driver.autoDownload = false;
    driver.autoInstallOnAppQuit = false;
    driver.allowPrerelease = false;
    driver.allowDowngrade = false;
    driver.on('update-available', (info) =>
      this.set({
        phase: 'available',
        version: info.version,
        message: automaticInstall
          ? '点击下载并更新，完成后自动重新启动。'
          : '此 macOS 安装包未启用签名更新，请下载新版安装包。',
      }),
    );
    driver.on('update-not-available', () =>
      this.set({ phase: 'current', version: undefined, message: '已是最新版本' }),
    );
    driver.on('download-progress', (info) =>
      this.set({ phase: 'downloading', progress: Math.round(info.percent) }),
    );
    driver.on('update-downloaded', () => this.set({ phase: 'downloaded', progress: 100 }));
    driver.on('error', () =>
      this.set({ phase: 'error', message: '更新失败，请检查网络后重试。当前版本仍可正常使用。' }),
    );
  }
  snapshot() {
    return { ...this.state };
  }
  private set(update: Partial<UpdateState>) {
    this.state = { ...this.state, ...update };
    this.changed(this.snapshot());
  }
  start() {
    if (!this.packaged) return;
    void this.check();
    this.timer = setInterval(
      () => {
        void this.check();
      },
      6 * 60 * 60 * 1000,
    );
    this.timer.unref();
  }
  dispose() {
    clearInterval(this.timer);
  }
  check(): Promise<UpdateState> {
    if (
      !this.packaged ||
      this.installing ||
      ['downloaded', 'installing'].includes(this.state.phase)
    )
      return Promise.resolve(this.snapshot());
    if (this.checking) return this.checking;
    this.set({ phase: 'checking', message: undefined });
    this.checking = this.driver
      .checkForUpdates()
      .then(() => this.snapshot())
      .catch(() => {
        this.set({ phase: 'error', message: '暂时无法检查更新，请检查网络或稍后重试。' });
        return this.snapshot();
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }
  install(): Promise<UpdateState> {
    if (this.installing) return this.installing;
    if (!this.packaged || !this.state.automaticInstall)
      throw new Error('此安装方式不支持自动安装，请下载正式安装包');
    if (!this.state.version) throw new Error('尚未发现可安装的更新');
    if (this.busy()) throw new Error('请先停止运行中的会话、终端和排队任务，再更新客户端');
    this.installing = (async () => {
      try {
        if (this.state.phase !== 'downloaded') {
          this.set({ phase: 'downloading', progress: 0, message: '正在下载并校验安装包…' });
          await this.driver.downloadUpdate();
          // A failed/cancelled download must never trigger installation.
          if (this.snapshot().phase !== 'downloaded') throw new Error('下载未完成');
        }
        if (this.busy()) {
          this.set({
            phase: 'downloaded',
            message: '已下载。当前有任务运行，停止任务后点击安装并重启。',
          });
        } else {
          this.set({ phase: 'installing', message: '正在安装并重新启动…' });
          this.driver.quitAndInstall(true, true);
        }
      } catch {
        this.set({ phase: 'error', message: '下载或安装失败，请重试。当前版本与数据已保留。' });
      }
      return this.snapshot();
    })().finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }
}
