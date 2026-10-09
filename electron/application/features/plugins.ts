import { registerPluginServices } from '../../modules/plugins/plugin-services';
import type { Plugin } from 'cordis';
import '../context';

export const pluginsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-plugins',
  inject: ['tzIpc', 'tzStore', 'tzExecution', 'tzConnectors', 'tzMcpAuth', 'tzDesktop'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = {
      changed: ctx.tzExecution.changed,
      invalidateNative: ctx.tzExecution.invalidateNative,
    };
    const connectors = ctx.tzConnectors;
    const mcpAuth = ctx.tzMcpAuth;
    const { getWindow } = ctx.tzDesktop;
    registerPluginServices(register, store, runtime, mcpAuth, connectors, () => getWindow());
  },
};
