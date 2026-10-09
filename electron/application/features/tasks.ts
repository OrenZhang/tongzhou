import { registerTaskServices } from '../../modules/sessions/task-services';
import type { Plugin } from 'cordis';
import '../context';

export const tasksPlugin: Plugin.Object<void> = {
  name: 'tongzhou-tasks',
  inject: [
    'tzIpc',
    'tzStore',
    'tzTasks',
    'tzTerminals',
    'tzMemories',
    'tzCheckpoints',
    'tzDesktop',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const services = {
      snapshot: ctx.tzTasks.snapshot.bind(ctx.tzTasks),
      terminals: ctx.tzTerminals,
      memories: ctx.tzMemories,
      checkpoints: ctx.tzCheckpoints,
      start: ctx.tzTasks.start.bind(ctx.tzTasks),
    };
    const { dataDir } = ctx.tzDesktop;
    registerTaskServices(register, store, services, dataDir);
  },
};
