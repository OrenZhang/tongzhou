import type { Approval, PendingInput, Session, Snapshot } from '../../../src/shared/types';
import type { Store } from '../../services/storage/store';
import { agentProfiles } from '../../modules/agents/agents';

export function runtimeSnapshot(store: Store, approvals: Approval[]): Snapshot {
  return {
    defaultPermission: store.defaultPermission(),
    bots: store.list<any>('bot').map((b) => ({ ...b, hasSecret: store.hasSecret('bot_' + b.id) })),
    connectors: store
      .list<any>('connector')
      .map((c) => ({ ...c, hasSecret: store.hasSecret('connector_' + c.id) })),
    channels: store.list('channel'),
    channelAuth: store.list('channelAuth'),
    notificationRules: store.list('notificationRule'),
    deliveries: store.list<any>('delivery').slice(-200).reverse(),
    authEvents: store.list('authEvent'),
    capabilities: store.capabilities(),
    pendingInputs: store
      .list<PendingInput>('pendingInput')
      .filter((p) => ['queued', 'paused', 'dispatching'].includes(p.status)),
    plugins: store.list<any>('plugin').map((p) => ({
      ...p,
      hasSecret: store.hasSecret(p.connectorId ? 'connector_' + p.connectorId : 'plugin_' + p.id),
      hasOAuthClientSecret: store.hasSecret('plugin_oauth_client_' + p.id),
    })),
    skills: store.list('skill'),
    providers: store.providers(),
    agents: agentProfiles(store),
    projects: store.list('project'),
    sessions: store
      .list<Session>('session')
      .filter((s) => !s.memoryJob)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    runs: store.recentRuns(),
    approvals: approvals,
  };
}
