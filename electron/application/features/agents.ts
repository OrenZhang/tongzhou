import { registerAgentServices } from '../../modules/agents/agent-services';
import type { Plugin } from 'cordis';
import '../context';

export const agentsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-agents',
  inject: ['tzIpc', 'tzStore', 'tzExecution'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = { changed: ctx.tzExecution.changed };
    registerAgentServices(register, store, runtime);
  },
};
