import { registerArtifactServices } from '../../modules/artifacts/artifact-services';
import type { Plugin } from 'cordis';
import '../execution-context';

export const artifactsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-artifacts',
  inject: [
    'tzEnvironment',
    'tzClient',
    'tzArtifacts',
    'tzStore',
    'tzContent',
    'tzKnowledge',
    'tzAutomations',
    'tzEvents',
  ],
  apply(ctx) {
    const register = ctx.tzClient.scoped(ctx);
    const services = {
      files: ctx.tzEnvironment.host.documents,
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
