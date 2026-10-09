import { registerTaskServices } from '../../modules/sessions/task-services';
import type { Plugin } from 'cordis';
import '../context';

export const tasksPlugin: Plugin.Object<void> = {
  name: 'tongzhou-tasks',
  inject: [
    'tzIpc',
    'tzStore',
    'tzExecution',
    'tzTerminals',
    'tzMemories',
    'tzCheckpoints',
    'tzDesktop',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = {
      snapshot: ctx.tzExecution.snapshot,
      terminals: ctx.tzTerminals,
      memories: ctx.tzMemories,
      checkpoints: ctx.tzCheckpoints,
      start: ctx.tzExecution.start,
    };
    const { dataDir } = ctx.tzDesktop;
    registerTaskServices(register, store, runtime, dataDir);
  },
};
