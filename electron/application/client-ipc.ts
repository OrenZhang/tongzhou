import type { IpcMain, BrowserWindow } from 'electron';
import { ClientCommands } from '../core/tools/client-commands';
import { ApplicationCommands } from './commands';
import { redact } from '../services/storage/validation';

/** Electron authenticates the main frame; business registration and draining are transport neutral. */
export class ClientIpc extends ApplicationCommands {
  constructor(
    commands: ClientCommands,
    ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
    getWindow: () => BrowserWindow | undefined,
    trusted: (url: string) => boolean,
    accepting: () => boolean,
  ) {
    super(commands, accepting, {
      register(name, execute) {
        const channel = 'tongzhou:' + name;
        ipc.handle(channel, async (event, ...args) => {
          if (!accepting()) throw new Error('应用正在退出');
          const window = getWindow();
          if (
            !window ||
            event.sender !== window.webContents ||
            !event.senderFrame ||
            event.senderFrame !== event.sender.mainFrame ||
            !trusted(event.senderFrame.url)
          )
            throw new Error('不可信的调用来源');
          try {
            return await execute(...args);
          } catch (e: any) {
            throw new Error(redact(e.message ?? String(e)));
          }
        });
        return () => ipc.removeHandler(channel);
      },
    });
  }
}
