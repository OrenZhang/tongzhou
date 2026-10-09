import type { AppEvent } from '../../src/shared/types';
import type { ComputerAdapter } from '../../electron/core/tools/extensions';
import { ApplicationEvents } from '../../electron/core/application-events';
import { createDomainServices } from '../../electron/modules/domain-services';
import { createTaskSystem } from '../../electron/application/task-system';
import type { ExecutionNetwork } from '../../electron/core/task-contracts';
import { Accounts } from '../../electron/services/accounts/accounts';
import type { Store } from '../../electron/services/storage/store';

export async function createTaskFixture(
  store: Store,
  dataDir: string,
  publish: (event: AppEvent) => void = () => {},
  computer?: ComputerAdapter,
) {
  const events = new ApplicationEvents(publish);
  const domains = createDomainServices(store, dataDir);
  const network: ExecutionNetwork = { resolve: async (profile) => profile };
  const system = await createTaskSystem(store, dataDir, events, domains, network, computer);
  const accounts = new Accounts(
    store,
    {
      snapshot: () => system.tasks.snapshot(),
      changed: events.changed,
      invalidateNative: events.invalidateNative,
      resolveNetwork: (profile) => network.resolve(profile),
      resetExecution: (providerId) => {
        events.emit('engineInvalidated', { providerId });
      },
    },
    dataDir,
    publish,
    async () => {},
  );
  return {
    ...system,
    events,
    domains,
    network,
    accounts,
    async dispose() {
      await accounts.dispose();
      await system.dispose();
      events.removeAllListeners();
    },
  };
}
