import { registerKnowledgeServices } from '../../modules/knowledge/knowledge-services';
import type { Plugin } from 'cordis';
import '../context';

export const knowledgePlugin: Plugin.Object<void> = {
  name: 'tongzhou-knowledge',
  inject: ['tzIpc', 'tzStore', 'tzKnowledge', 'tzExecution', 'tzAutomations'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = {
      knowledge: ctx.tzKnowledge,
      changed: ctx.tzExecution.changed,
      processMemory: ctx.tzExecution.processMemory,
      start: ctx.tzExecution.start,
      automations: ctx.tzAutomations,
    };
    registerKnowledgeServices(register, store, runtime);
  },
};
