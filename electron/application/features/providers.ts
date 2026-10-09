import { registerProviderServices } from '../../services/accounts/provider-services';
import type { Plugin } from 'cordis';
import '../context';

export const providersPlugin: Plugin.Object<void> = {
  name: 'tongzhou-providers',
  inject: [
    'tzIpc',
    'tzStore',
    'tzRuntime',
    'tzNetworks',
    'tzAccounts',
    'tzAccountBrowser',
    'tzDesktop',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = ctx.tzRuntime;
    const networks = ctx.tzNetworks;
    const accounts = ctx.tzAccounts;
    const accountBrowser = ctx.tzAccountBrowser;
    const { pendingImports } = ctx.tzDesktop;
    registerProviderServices(
      register,
      store,
      runtime,
      accounts,
      accountBrowser,
      networks,
      pendingImports,
    );
  },
};
