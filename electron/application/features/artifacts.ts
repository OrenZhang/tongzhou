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
    'tzExecution',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const runtime = {
      artifacts: ctx.tzArtifacts,
      store: ctx.tzStore,
      content: ctx.tzContent,
      knowledge: ctx.tzKnowledge,
      automations: ctx.tzAutomations,
      changed: ctx.tzExecution.changed,
    };
    registerArtifactServices(register, runtime);
  },
};
