import { desktopDocumentHost } from '../../services/desktop/document-host';
import { registerContentServices } from '../../modules/content/content-services';
import type { Plugin } from 'cordis';
import '../context';

export const contentPlugin: Plugin.Object<void> = {
  name: 'tongzhou-content',
  inject: ['tzIpc', 'tzStore', 'tzContent', 'tzKnowledge', 'tzEvents', 'tzTasks', 'tzAutomations'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const services = {
      files: desktopDocumentHost,
      content: ctx.tzContent,
      knowledge: ctx.tzKnowledge,
      changed: ctx.tzEvents.changed,
      start: ctx.tzTasks.start.bind(ctx.tzTasks),
      automations: ctx.tzAutomations,
    };
    registerContentServices(register, store, services);
  },
};
