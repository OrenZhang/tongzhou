import { registerKnowledgeServices } from '../../modules/knowledge/knowledge-services';
import type { Plugin } from 'cordis';
import '../context';

export const knowledgePlugin: Plugin.Object<void> = {
  name: 'tongzhou-knowledge',
  inject: ['tzIpc', 'tzStore', 'tzKnowledge', 'tzEvents', 'tzAutomations', 'tzTasks'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const services = {
      knowledge: ctx.tzKnowledge,
      changed: ctx.tzEvents.changed,
      processMemory: ctx.tzAutomations.processMemory.bind(ctx.tzAutomations),
      start: ctx.tzTasks.start.bind(ctx.tzTasks),
      automations: ctx.tzAutomations,
    };
    registerKnowledgeServices(register, store, services);
  },
};
