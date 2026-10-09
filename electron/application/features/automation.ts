import { registerAutomationServices } from '../../modules/automation/automation-services';
import type { Plugin } from 'cordis';
import '../context';

export const automationPlugin: Plugin.Object<void> = {
  name: 'tongzhou-automation',
  inject: ['tzIpc', 'tzAutomations', 'tzStore', 'tzKnowledge'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const services = {
      automations: ctx.tzAutomations,
      store: ctx.tzStore,
      knowledge: ctx.tzKnowledge,
    };
    registerAutomationServices(register, services);
  },
};
