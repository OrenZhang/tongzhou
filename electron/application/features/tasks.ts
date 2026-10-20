import { registerTaskServices } from '../../modules/sessions/task-services';
import type { Plugin } from 'cordis';
import '../execution-context';

export const tasksPlugin: Plugin.Object<void> = {
  name: 'tongzhou-tasks',
  inject: [
    'tzClient',
    'tzStore',
    'tzTasks',
    'tzTerminals',
    'tzMemories',
    'tzCheckpoints',
    'tzEnvironment',
  ],
  apply(ctx) {
    const register = ctx.tzClient.scoped(ctx);
    const store = ctx.tzStore;
    const services = {
      snapshot: ctx.tzTasks.snapshot.bind(ctx.tzTasks),
      terminals: ctx.tzTerminals,
      memories: ctx.tzMemories,
      checkpoints: ctx.tzCheckpoints,
      start: ctx.tzTasks.start.bind(ctx.tzTasks),
    };
    const { dataDir } = ctx.tzEnvironment;
    registerTaskServices(register, store, services, dataDir, ctx.tzEnvironment.host);
  },
};
