import { registerArtifactServices } from '../../modules/artifacts/artifact-services';
import type { Plugin } from 'cordis';
import '../context';

export const artifactsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-artifacts',
  inject: [
    'tzIpc',
    'tzArtifacts',
    'tzStore',
    'tzContent',
    'tzKnowledge',
    'tzAutomations',
    'tzEvents',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const services = {
      artifacts: ctx.tzArtifacts,
      store: ctx.tzStore,
      content: ctx.tzContent,
      knowledge: ctx.tzKnowledge,
      automations: ctx.tzAutomations,
      changed: ctx.tzEvents.changed,
    };
    registerArtifactServices(register, services);
  },
};
