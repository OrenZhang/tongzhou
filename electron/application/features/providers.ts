import { registerProviderServices } from '../../services/accounts/provider-services';
import type { Plugin } from 'cordis';
import '../execution-context';

export const providersPlugin: Plugin.Object<void> = {
  name: 'tongzhou-providers',
  inject: [
    'tzClient',
    'tzStore',
    'tzTasks',
    'tzNetworks',
    'tzAccounts',
    'tzAccountBrowser',
    'tzProviderImports',
    'tzEvents',
  ],
  apply(ctx) {
    const register = ctx.tzClient.scoped(ctx);
    const store = ctx.tzStore;
    const services = ctx.tzTasks;
    const networks = ctx.tzNetworks;
    const accounts = ctx.tzAccounts;
    const accountBrowser = ctx.tzAccountBrowser;
    const pendingImports = ctx.tzProviderImports;
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
