import { registerAgentServices } from '../../modules/agents/agent-services';
import type { Plugin } from 'cordis';
import '../execution-context';

export const agentsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-agents',
  inject: ['tzClient', 'tzStore', 'tzEvents'],
  apply(ctx) {
    const register = ctx.tzClient.scoped(ctx);
    const store = ctx.tzStore;
    const services = { changed: ctx.tzEvents.changed };
    registerAgentServices(register, store, services);
  },
};
