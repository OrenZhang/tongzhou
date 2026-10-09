import { ipcMain } from 'electron';
import { ClientCommands } from '../core/tools/client-commands';
import type { Runtime } from '../core/runtime/runtime';
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

  get runtime() {
    return this.kernel.get<Runtime>('tzRuntime');
  }

  stop() {
    return this.kernel.stop(async () => {
      const runtime = this.kernel.context.get('tzRuntime', false);
      if (runtime) {
        runtime.stop();
        await Promise.all([
          runtime.waitForIdle(),
          this.kernel.context.get('tzIpc', false)?.waitForIdle(),
        ]);
      }
    });
  }
}
