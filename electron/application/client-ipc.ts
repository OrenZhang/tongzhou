import type { Context } from 'cordis';
import type { IpcMain, BrowserWindow } from 'electron';
import {
  ClientCommands,
  type ClientOperation,
  type ClientRegistrar,
} from '../core/tools/client-commands';
import { redact } from '../services/storage/validation';

/** Shares one reversible registration between Electron IPC and the agent capability catalog. */
export class ClientIpc {
  private pending = new Set<Promise<unknown>>();
  constructor(
    private commands: ClientCommands,
    private ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
    private getWindow: () => BrowserWindow | undefined,
    private trusted: (url: string) => boolean,
    private accepting: () => boolean,
  ) {}

  scoped(ctx: Context): ClientRegistrar {
    return (name, definition, handler) => {
      ctx.effect(() => this.register(name, definition, handler));
    };
  }

  async waitForIdle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private register(name: string, definition: ClientOperation, handler: (...args: any[]) => any) {
    const execute = (...args: any[]) => {
      if (!this.accepting()) throw new Error('应用正在退出');
      const result = handler(...args);
      if (result && typeof result.then === 'function') {
        const pending = Promise.resolve(result);
        this.pending.add(pending);
        void pending.then(
          () => this.pending.delete(pending),
          () => this.pending.delete(pending),
        );
      }
      return result;
    };
    const removeCommand = this.commands.register(name, definition, execute);
    const channel = 'tongzhou:' + name;
    try {
      this.ipc.handle(channel, async (event, ...args) => {
        if (!this.accepting()) throw new Error('应用正在退出');
        const window = this.getWindow();
        if (
          !window ||
          event.sender !== window.webContents ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          !this.trusted(event.senderFrame.url)
        )
          throw new Error('不可信的调用来源');
        try {
          return await execute(...args);
        } catch (e: any) {
          throw new Error(redact(e.message ?? String(e)));
        }
      });
    } catch (error) {
      removeCommand();
      throw error;
    }
    return () => {
      this.ipc.removeHandler(channel);
      removeCommand();
    };
  }
}
