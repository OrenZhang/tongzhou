import { registerContentServices } from '../../modules/content/content-services';
import type { Plugin } from 'cordis';
import '../context';

export const contentPlugin: Plugin.Object<void> = {
  name: 'tongzhou-content',
  inject: ['tzIpc', 'tzStore', 'tzContent', 'tzKnowledge', 'tzExecution', 'tzAutomations'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = {
      content: ctx.tzContent,
      knowledge: ctx.tzKnowledge,
      changed: ctx.tzExecution.changed,
      start: ctx.tzExecution.start,
      automations: ctx.tzAutomations,
    };
    registerContentServices(register, store, runtime);
  },
};
