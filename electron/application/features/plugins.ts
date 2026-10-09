import { registerPluginServices } from '../../modules/plugins/plugin-services';
import type { Plugin } from 'cordis';
import '../context';

export const pluginsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-plugins',
  inject: ['tzIpc', 'tzStore', 'tzEvents', 'tzConnectors', 'tzMcpAuth', 'tzDesktop'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const services = {
      changed: ctx.tzEvents.changed,
      invalidateNative: ctx.tzEvents.invalidateNative,
    };
    const connectors = ctx.tzConnectors;
    const mcpAuth = ctx.tzMcpAuth;
    const { getWindow } = ctx.tzDesktop;
    registerPluginServices(register, store, services, mcpAuth, connectors, () => getWindow());
  },
};
