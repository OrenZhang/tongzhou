import { randomUUID } from 'node:crypto';
import { CodexAuth } from './codex-auth';
import { NativeAccount } from './native-engine';
import { engineHome } from './account-paths';
import type { Store } from '../storage/store';
import type { TaskService, ChangePublisher } from '../../core/task-contracts';
import { CodexClient } from '../../core/codex/codex';
import type { ProviderNetwork } from '../../../src/shared/provider-network';
import type { AppEvent, NativeEngine, Provider } from '../../../src/shared/types';
import { redact } from '../storage/validation';

export interface AccountDependencies extends Pick<TaskService, 'snapshot'>, ChangePublisher {
  invalidateNative(protocol?: string): void;
  resolveNetwork?(network?: ProviderNetwork): Promise<ProviderNetwork | undefined>;
  resetExecution(providerId: string): void;
}

export class Accounts {
  private clients = new Map<string, CodexClient>();
  private natives = new Map<string, NativeAccount>();
  private codices = new Map<string, CodexAuth>();
  private lastEvent = new Map<string, string>();
  constructor(
    private store: Store,
    private services: AccountDependencies,
    private dataDir: string,
    private emit: (e: AppEvent) => void,
    private open: (url: string, providerId: string) => Promise<void>,
  ) {}
  private verify(id: string, protocol: string) {
    const p = this.store.get<Provider>('provider', id);
    if (p.protocol !== protocol) throw new Error('认证与所选连接不匹配');
    return p;
  }
  private record(providerId: string, phase: string, error?: string) {
    if (!this.store.providers().some((p) => p.id === providerId)) return;
    const signature = phase + ':' + (error ?? '');
    if (this.lastEvent.get(providerId) === signature) return;
    this.lastEvent.set(providerId, signature);
    this.store.put('authEvent', {
      id: randomUUID(),
      providerId,
      phase,
      time: Date.now(),
      error: error ? redact(error).slice(0, 500) : undefined,
    });
    const records = this.store.list<any>('authEvent');
    for (const item of records.slice(0, Math.max(0, records.length - 500)))
      this.store.remove('authEvent', item.id);
    this.services.changed();
  }
  idle(id: string) {
    if (this.services.snapshot().runs.some((r) => r.providerId === id && r.status === 'running'))
      throw new Error('请先停止此账号的任务，再修改授权');
    const protocol = this.store.get<Provider>('provider', id).protocol;
    if (protocol !== 'codex') this.services.invalidateNative(protocol);
  }
  native(engine: NativeEngine, id = `${engine}-account`) {
    this.verify(id, engine);
    let account = this.natives.get(id);
    if (!account) {
      account = new NativeAccount(
        engine,
        engineHome(this.dataDir, engine, id),
        (state) => {
          this.emit({ type: 'native-auth', state: { ...state, providerId: id } });
          if (['success', 'error', 'cancelled'].includes(state.phase))
            this.record(id, state.phase, state.error);
        },
        (catalog) => {
          const p = this.verify(id, engine);
          this.store.put('provider', {
            ...p,
            models: catalog.models,
            modelLabels: catalog.modelLabels,
          });
          this.services.changed();
        },
      );
      this.natives.set(id, account);
    }
    return account;
  }
  codex(id = 'openai-codex') {
    this.verify(id, 'codex');
    let account = this.codices.get(id);
    if (!account) {
      const client = this.client(id);
      account = new CodexAuth(
        client,
        (url) => this.open(url, id),
        (state) => {
          this.emit({ type: 'codex-auth', state: { ...state, providerId: id } });
          if (state.login?.phase) this.record(id, state.login.phase, state.login.error);
        },
        async () => {
          const result = await client.request('model/list', { includeHidden: false });
          const p = this.verify(id, 'codex');
          this.store.put('provider', {
            ...p,
            models: result.data
              .map((m: any) => m.model ?? m.id)
              .filter((m: unknown) => typeof m === 'string'),
          });
          this.services.changed();
        },
      );
      this.codices.set(id, account);
    }
    return account;
  }
  client(id = 'openai-codex') {
    this.verify(id, 'codex');
    let client = this.clients.get(id);
    if (!client) {
      client = new CodexClient(
        engineHome(this.dataDir, 'codex', id),
        this.store.get<Provider>('provider', id).network,
        (network) =>
          this.services.resolveNetwork
            ? this.services.resolveNetwork(network)
            : Promise.resolve(network),
      );
      const current = client;
      client.on('request', (r) => current.reject(r.id, 'Login client does not execute tools'));
      client.on('notification', this.services.changed);
      this.clients.set(id, client);
    }
    return client;
  }
  async dispose() {
    for (const a of this.natives.values()) a.dispose();
    for (const a of this.codices.values()) a.dispose();
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }
  resetCodex(id: string) {
    this.codices.get(id)?.dispose();
    this.codices.delete(id);
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    this.services.resetExecution(id);
  }
  forget(id: string) {
    this.natives.get(id)?.dispose();
    this.natives.delete(id);
    this.codices.get(id)?.dispose();
    this.codices.delete(id);
    this.lastEvent.delete(id);
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    this.services.invalidateNative();
  }
}
