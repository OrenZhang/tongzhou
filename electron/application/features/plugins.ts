import { registerPluginServices } from '../../modules/plugins/plugin-services';
import type { Plugin } from 'cordis';
import '../execution-context';

export const pluginsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-plugins',
  inject: ['tzClient', 'tzStore', 'tzEvents', 'tzConnectors', 'tzMcpAuth', 'tzEnvironment'],
  apply(ctx) {
    const register = ctx.tzClient.scoped(ctx);
    const store = ctx.tzStore;
    const services = {
      changed: ctx.tzEvents.changed,
      invalidateNative: ctx.tzEvents.invalidateNative,
    };
    const connectors = ctx.tzConnectors;
    const mcpAuth = ctx.tzMcpAuth;

    registerPluginServices(
      register,
      store,
      services,
      mcpAuth,
      connectors,
      ctx.tzEnvironment.host.dialogs,
    );
  },
};
