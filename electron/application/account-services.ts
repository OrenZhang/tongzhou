import type { Plugin } from 'cordis';
import type { ApplicationKernel } from './kernel';
import type { Store } from '../services/storage/store';
import { Accounts, type AccountBrowserHost } from '../services/accounts/accounts';
import type { ExecutionNetwork } from '../core/task-contracts';
import type { Provider } from '../../src/shared/types';
import './execution-context';

export function accountServices(
  kernel: ApplicationKernel,
  browser: (store: Store, resolve: ExecutionNetwork['resolve']) => AccountBrowserHost,
): Plugin.Object<void>[] {
  return [
    {
      name: 'tongzhou-account-browser-service',
      inject: ['tzEnvironment', 'tzStore', 'tzNetworks', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const networks = ctx.tzNetworks;

        const accountBrowser = browser(store, (network) => networks.resolve(network));
        kernel.own(ctx, async () => {
          accountBrowser.dispose();
        });
        ctx.provide('tzAccountBrowser', accountBrowser);
        const close = (id: string) => accountBrowser.close(id);
        ctx.effect(() => {
          ctx.tzEvents.on('accountReset', close);
          return () => ctx.tzEvents.off('accountReset', close);
        });
      },
    },
    {
      name: 'tongzhou-accounts-service',
      inject: [
        'tzEnvironment',
        'tzStore',
        'tzEvents',
        'tzTasks',
        'tzAccountBrowser',
        'tzModelNetwork',
      ],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const accountBrowser = ctx.tzAccountBrowser;
        const { dataDir, emit } = ctx.tzEnvironment;
        for (const engine of ['kimi', 'minimax'] as const) {
          const providerId = engine + '-account';
          if (!store.list<Provider>('provider').some((p) => p.id === providerId))
            store.saveProvider({
              id: providerId,
              name: engine === 'kimi' ? 'Kimi · 账号授权' : 'MiniMax · 账号授权',
              enabled: false,
              protocol: engine,
              auth: 'native',
              baseUrl: '',
              models: [],
              maxOutputTokens: 8192,
              contextChars: 0,
            });
        }
        const tasks = ctx.tzTasks;
        const accounts = new Accounts(
          store,
          {
            snapshot: tasks.snapshot.bind(tasks),
            changed: events.changed,
            invalidateNative: events.invalidateNative,
            resolveNetwork: (network) => ctx.tzModelNetwork.resolve(network),
            resetExecution: (providerId) => {
              events.emit('engineInvalidated', { providerId });
            },
          },
          dataDir,
          emit,
          (url, id) => accountBrowser.open(url, id),
        );
        const reset = (id: string) => accounts.resetCodex(id);
        ctx.effect(() => {
          events.on('accountReset', reset);
          return () => events.off('accountReset', reset);
        });
        kernel.own(ctx, async () => {
          await accounts.dispose();
        });
        ctx.provide('tzAccounts', accounts);
      },
    },
  ];
}
