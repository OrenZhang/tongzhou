import { ipcMain } from 'electron';
import { ClientCommands } from '../core/tools/client-commands';
import type { TaskService } from '../core/task-contracts';
import { ApplicationEvents } from '../core/application-events';
import { ApplicationKernel } from './kernel';
import { ClientIpc } from './client-ipc';
import type { DesktopEnvironment } from './context';
import { applicationServices } from './services';
import { applicationFeatures } from './features';

export class DesktopApplication {
  readonly kernel = new ApplicationKernel();

  constructor(private desktop: DesktopEnvironment) {}

  async start() {
    try {
      await this.kernel.mount({
        name: 'tongzhou-desktop',
        apply: (ctx) => {
          const commands = new ClientCommands();
          ctx.provide('tzDesktop', this.desktop);
          const events = new ApplicationEvents(this.desktop.emit);
          ctx.provide('tzEvents', events);
          this.kernel.own(ctx, () => {
            events.removeAllListeners();
          });
          ctx.provide('tzCommands', commands);
          ctx.provide(
            'tzIpc',
            new ClientIpc(
              commands,
              ipcMain,
              this.desktop.getWindow,
              this.desktop.trusted,
              () => this.kernel.accepting,
            ),
          );
          this.kernel.own(ctx, () => {
            this.desktop.computerPermissionPanel.close();
            this.desktop.pendingImports.clear();
          });
        },
      });
      for (const plugin of applicationServices(this.kernel)) await this.kernel.mount(plugin);
      for (const plugin of applicationFeatures) await this.kernel.mount(plugin);
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  get tasks() {
    return this.kernel.get<TaskService>('tzTasks');
  }

  stop() {
    return this.kernel.stop(async () => {
      const tasks = this.kernel.context.get('tzTasks', false);
      if (tasks) {
        tasks.stop();
        await Promise.all([
          tasks.waitForIdle(),
          this.kernel.context.get('tzIpc', false)?.waitForIdle(),
        ]);
      }
    });
  }
}
