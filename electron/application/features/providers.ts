import { registerProviderServices } from '../../services/accounts/provider-services';
import type { Plugin } from 'cordis';
import '../context';

export const providersPlugin: Plugin.Object<void> = {
  name: 'tongzhou-providers',
  inject: [
    'tzIpc',
    'tzStore',
    'tzTasks',
    'tzNetworks',
    'tzAccounts',
    'tzAccountBrowser',
    'tzDesktop',
    'tzEvents',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const services = ctx.tzTasks;
    const networks = ctx.tzNetworks;
    const accounts = ctx.tzAccounts;
    const accountBrowser = ctx.tzAccountBrowser;
    const { pendingImports } = ctx.tzDesktop;
    registerProviderServices(
      register,
      store,
      { snapshot: services.snapshot.bind(services), changed: ctx.tzEvents.changed },
      accounts,
      accountBrowser,
      networks,
      pendingImports,
    );
  },
};
