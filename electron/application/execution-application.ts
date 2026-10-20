import type { Plugin } from 'cordis';
import { ClientCommands } from '../core/tools/client-commands';
import { ApplicationEvents } from '../core/application-events';
import type { TaskService } from '../core/task-contracts';
import { ApplicationKernel } from './kernel';
import { ApplicationCommands } from './commands';
import type { ExecutionEnvironment } from './execution-context';
import { executionServices } from './execution-services';
import { executionFeatures } from './execution-features';

interface HostExtensions {
  setup?: Plugin.Object<void>;
  services?: (kernel: ApplicationKernel) => Plugin.Object<void>[];
  features?: Plugin.Object<void>[];
  commands?: (catalog: ClientCommands, accepting: () => boolean) => ApplicationCommands;
}

/** The same executor is composed in a desktop host or an ordinary Node process. */
export class ExecutionApplication {
  readonly kernel = new ApplicationKernel();
  private started = false;

  constructor(
    private environment: ExecutionEnvironment,
    private extensions: HostExtensions = {},
  ) {}

  async start() {
    if (this.started) throw new Error('应用已经启动');
    this.started = true;
    try {
      await this.kernel.mount({
        name: 'tongzhou-execution',
        apply: (ctx) => {
          const catalog = new ClientCommands();
          ctx.provide('tzEnvironment', this.environment);
          ctx.provide('tzProviderImports', this.environment.pendingImports ?? new Map());
          ctx.provide('tzEvents', new ApplicationEvents(this.environment.emit));
          this.kernel.own(ctx, () => {
            ctx.tzEvents.removeAllListeners();
          });
          ctx.provide('tzCommands', catalog);
          ctx.provide(
            'tzClient',
            this.extensions.commands?.(catalog, () => this.kernel.accepting) ??
              new ApplicationCommands(catalog, () => this.kernel.accepting),
          );
        },
      });
      if (this.extensions.setup) await this.kernel.mount(this.extensions.setup);
      for (const plugin of executionServices(this.kernel)) await this.kernel.mount(plugin);
      for (const plugin of this.extensions.services?.(this.kernel) ?? [])
        await this.kernel.mount(plugin);
      for (const plugin of executionFeatures) await this.kernel.mount(plugin);
      for (const plugin of this.extensions.features ?? []) await this.kernel.mount(plugin);
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], '应用启动失败，清理资源时发生错误');
      }
      throw error;
    }
  }

  get tasks() {
    return this.kernel.get<TaskService>('tzTasks');
  }
  get client() {
    return this.kernel.get<ApplicationCommands>('tzClient');
  }

  stop() {
    return this.kernel.stop(async () => {
      const tasks = this.kernel.context.get('tzTasks', false);
      await Promise.all([
        tasks?.stop(),
        tasks?.waitForIdle(),
        this.kernel.context.get('tzClient', false)?.waitForIdle(),
      ]);
    });
  }
}
