import { registerAutomationServices } from '../../modules/automation/automation-services';
import type { Plugin } from 'cordis';
import '../execution-context';

export const automationPlugin: Plugin.Object<void> = {
  name: 'tongzhou-automation',
  inject: ['tzClient', 'tzAutomations', 'tzStore', 'tzKnowledge'],
  apply(ctx) {
    const register = ctx.tzClient.scoped(ctx);
    const services = {
      automations: ctx.tzAutomations,
      store: ctx.tzStore,
      knowledge: ctx.tzKnowledge,
    };
    registerAutomationServices(register, services);
  },
};
