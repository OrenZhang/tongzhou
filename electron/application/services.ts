import { createDomainServices } from '../modules/domain-services';
import { createTaskSystem } from './task-system';
import { app, safeStorage, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Provider } from '../../src/shared/types';
import { ensureBuiltinPlugins } from '../modules/plugins/builtin-plugins';
import { McpAuth } from '../modules/plugins/mcp-auth';
import { ensureBuiltinSkills } from '../modules/plugins/skills';
import { GitRepositories } from '../modules/projects/git-repositories';
import { Worktrees } from '../modules/projects/worktrees';
import { AccountBrowser } from '../services/accounts/account-browser';
import { Accounts } from '../services/accounts/accounts';
import { Connectors } from '../services/accounts/connectors';
import { Bots } from '../services/channels/bots';
import { Channels } from '../services/channels/channels';
import { Feishu } from '../services/channels/feishu';
import { Updates } from '../services/desktop/updates';
import { NetworkProfiles } from '../services/network/network-profiles';
import { accountProxyConfig } from '../services/network/provider-network';
import { userAgent } from '../services/network/request-identity';
import { setServiceTransport } from '../services/network/service-network';
import { applyPendingRestore } from '../services/storage/data-maintenance';
import { Store } from '../services/storage/store';
import type { Plugin } from 'cordis';
import type { ApplicationKernel } from './kernel';
import './context';

export function applicationServices(kernel: ApplicationKernel): Plugin.Object<void>[] {
  return [
    {
      name: 'tongzhou-storage-service',
      inject: ['tzDesktop'],
      apply(ctx) {
        const { dataDir, bundleDir } = ctx.tzDesktop;
        const serviceSession = session.fromPartition('tongzhou-service-network');
        setServiceTransport((input, init) =>
          serviceSession.fetch(input instanceof URL ? input.href : input, {
            ...init,
            bypassCustomProtocolHandlers: true,
          }),
        );
        kernel.own(ctx, () => setServiceTransport());
        applyPendingRestore(dataDir);
        const store = new Store(path.join(dataDir, 'tongzhou.db'), {
          encrypt(value) {
            if (
              !safeStorage.isEncryptionAvailable() ||
              (process.platform === 'linux' &&
                safeStorage.getSelectedStorageBackend() === 'basic_text')
            )
              throw new Error('系统安全存储不可用，拒绝明文保存密钥');
            return safeStorage.encryptString(value).toString('base64');
          },
          decrypt(value) {
            if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用');
            return safeStorage.decryptString(Buffer.from(value, 'base64'));
          },
        });
        kernel.own(ctx, async () => {
          store.close();
        });
        ctx.provide('tzStore', store);
        const require = createRequire(path.join(bundleDir, '../package.json'));
        const nodeRoot = path
          .dirname(require.resolve('node/package.json'))
          .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
        ensureBuiltinPlugins(
          store,
          path.join(nodeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
          path
            .join(bundleDir, 'builtin-mcp.cjs')
            .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
        );
        ensureBuiltinSkills(store, path.join(bundleDir, 'skills'));
      },
    },
    {
      name: 'tongzhou-domain-services',
      inject: ['tzStore', 'tzDesktop'],
      apply(ctx) {
        const domains = createDomainServices(ctx.tzStore, ctx.tzDesktop.dataDir);
        ctx.provide('tzKnowledge', domains.knowledge);
        ctx.provide('tzContent', domains.content);
        ctx.provide('tzArtifacts', domains.artifacts);
        ctx.provide('tzAttachments', domains.attachments);
        ctx.provide('tzMemories', domains.memories);
        ctx.provide('tzCheckpoints', domains.checkpoints);
      },
    },
    {
      name: 'tongzhou-updates-service',
      inject: ['tzDesktop', 'tzStore'],
      apply(ctx) {
        const store = ctx.tzStore;
        const { bundleDir, emit } = ctx.tzDesktop;
        const require = createRequire(path.join(bundleDir, '../package.json'));
        const updates = new Updates(
          autoUpdater,
          app.getVersion(),
          app.isPackaged && ['win32', 'darwin'].includes(process.platform),
          process.platform === 'win32' ||
            require(path.join(app.getAppPath(), 'package.json')).tongzhouMacAutoUpdate === true,
          () =>
            store
              .list<import('../../src/shared/types').Run>('run')
              .some((r) => r.status === 'running') ||
            store.list<any>('terminal').some((t) => t.status === 'running') ||
            store
              .list<any>('pendingInput')
              .some((p) => ['queued', 'dispatching'].includes(p.status)),
          (state) => emit({ type: 'update', state }),
        );
        kernel.own(ctx, async () => {
          updates.dispose();
        });
        ctx.provide('tzUpdates', updates);
      },
    },
    {
      name: 'tongzhou-network-service',
      inject: ['tzDesktop', 'tzStore', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const { dataDir } = ctx.tzDesktop;
        const networks = new NetworkProfiles(
          store,
          dataDir,
          events.changed,
          (id, exceptRunId) => {
            const ids = store
              .providers()
              .filter((p) => p.network?.mode === 'managed' && p.network.profileId === id)
              .map((p) => p.id);
            if (
              store
                .list<import('../../src/shared/types').Run>('run')
                .some(
                  (r) =>
                    ids.includes(r.providerId) && r.status === 'running' && r.id !== exceptRunId,
                )
            )
              throw new Error('使用此网络的账号正在执行任务，请结束任务后再修改、切换或停止网络。');
          },
          (id) => {
            for (const p of store
              .providers()
              .filter((p) => p.network?.mode === 'managed' && p.network.profileId === id)) {
              events.emit('accountReset', p.id);
            }
          },
          undefined,
          (id) => {
            for (const p of store
              .providers()
              .filter((p) => p.network?.mode === 'managed' && p.network.profileId === id))
              events.emit('engineInvalidated', { providerId: p.id });
          },
        );
        kernel.own(ctx, async () => {
          await networks.dispose();
        });
        ctx.provide('tzNetworks', networks);

        const modelTransports = new Map<string, Promise<typeof fetch>>();
        const transport: NonNullable<
          import('../core/task-contracts').ExecutionNetwork['transport']
        > = (network) => {
          const key = JSON.stringify(network ?? { mode: 'inherit' });
          let pending = modelTransports.get(key);
          if (!pending) {
            pending = (async () => {
              const isolated = session.fromPartition(
                'tongzhou-model-' + Buffer.from(key).toString('hex'),
              );
              await isolated.setProxy(accountProxyConfig(network));
              return ((input, init) =>
                isolated.fetch(input as string, {
                  ...init,
                  headers: {
                    ...Object.fromEntries(new Headers(init?.headers)),
                    'User-Agent': userAgent,
                  },
                  credentials: 'omit',
                })) as typeof fetch;
            })();
            modelTransports.set(key, pending);
            void pending.catch(() => modelTransports.delete(key));
          }
          return pending;
        };
        ctx.provide('tzModelNetwork', {
          resolve: (network, runId) => networks.resolve(network, runId),
          transport,
        });
        kernel.own(ctx, () => modelTransports.clear());
      },
    },
    {
      name: 'tongzhou-connectors-service',
      inject: ['tzStore', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const connectors = new Connectors(store, events.changed);
        kernel.own(ctx, async () => {
          connectors.dispose();
        });
        ctx.provide('tzConnectors', connectors);
      },
    },
    {
      name: 'tongzhou-project-tools-service',
      inject: ['tzDesktop', 'tzStore', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const { dataDir } = ctx.tzDesktop;
        const worktrees = new Worktrees(store, dataDir, events.changed);
        const repositories = new GitRepositories(store, dataDir, events.changed);
        ctx.provide('tzProjectTools', { worktrees, repositories, activity: { count: 0 } });
      },
    },
    {
      name: 'tongzhou-task-services',
      inject: [
        'tzDesktop',
        'tzStore',
        'tzCommands',
        'tzEvents',
        'tzModelNetwork',
        'tzProjectTools',
        'tzKnowledge',
        'tzContent',
        'tzArtifacts',
        'tzAttachments',
        'tzMemories',
        'tzCheckpoints',
      ],
      async apply(ctx) {
        const { dataDir, computer } = ctx.tzDesktop;
        const system = await createTaskSystem(
          ctx.tzStore,
          dataDir,
          ctx.tzEvents,
          {
            knowledge: ctx.tzKnowledge,
            content: ctx.tzContent,
            artifacts: ctx.tzArtifacts,
            attachments: ctx.tzAttachments,
            memories: ctx.tzMemories,
            checkpoints: ctx.tzCheckpoints,
          },
          ctx.tzModelNetwork,
          computer,
          ctx.tzCommands,
          (id) => ctx.tzProjectTools.worktrees.isRemoving(id),
        );
        kernel.own(ctx, system.dispose);
        ctx.provide('tzTasks', system.tasks);
        ctx.provide('tzAutomations', system.automations);
        ctx.provide('tzSessions', system.sessions);
        ctx.provide('tzApprovals', system.approvals);
        ctx.provide('tzTerminals', system.terminals);
      },
    },
    {
      name: 'tongzhou-mcp-auth-service',
      inject: ['tzStore', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const mcpAuth = new McpAuth(store, events.changed, (url) => shell.openExternal(url));
        kernel.own(ctx, async () => {
          mcpAuth.dispose();
        });
        ctx.provide('tzMcpAuth', mcpAuth);
      },
    },
    {
      name: 'tongzhou-feishu-service',
      inject: ['tzStore', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const feishu = new Feishu(store, {
          changed: events.changed,
        });
        kernel.own(ctx, async () => {
          feishu.dispose();
        });
        ctx.provide('tzFeishu', feishu);
      },
    },
    {
      name: 'tongzhou-bots-service',
      inject: ['tzStore', 'tzEvents', 'tzTasks'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const tasks = ctx.tzTasks;
        const bots = new Bots(store, {
          start: tasks.start.bind(tasks),
          isActive: tasks.isActive.bind(tasks),
          enqueue: tasks.enqueue.bind(tasks),
          cancel: tasks.cancel.bind(tasks),
          snapshot: tasks.snapshot.bind(tasks),
          changed: events.changed,
        });
        kernel.own(ctx, async () => {
          bots.dispose();
        });
        ctx.provide('tzBots', bots);
        const notify = (
          run: import('../../src/shared/types').Run,
          event: import('../core/application-events').Lifecycle,
        ) => {
          void bots.notify(run, event).catch(() => {});
        };
        ctx.effect(() => {
          events.on('lifecycle', notify);
          return () => events.off('lifecycle', notify);
        });
        bots.sync();
      },
    },
    {
      name: 'tongzhou-channels-service',
      inject: ['tzStore', 'tzEvents', 'tzBots'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const channels = new Channels(store, () => {
          events.changed();
        });
        kernel.own(ctx, async () => {
          channels.dispose();
        });
        channels.attachTargets(ctx.tzBots.notifications);
        ctx.provide('tzChannels', channels);
        const notify = (
          run: import('../../src/shared/types').Run,
          event: import('../core/application-events').Lifecycle,
          id?: string,
        ) => {
          void channels.notify(run, event, id).catch(() => {});
        };
        ctx.effect(() => {
          events.on('lifecycle', notify);
          return () => events.off('lifecycle', notify);
        });
      },
    },
    {
      name: 'tongzhou-account-browser-service',
      inject: ['tzDesktop', 'tzStore', 'tzNetworks', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const networks = ctx.tzNetworks;

        const accountBrowser = new AccountBrowser(store, (network) => networks.resolve(network));
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
      inject: ['tzDesktop', 'tzStore', 'tzEvents', 'tzTasks', 'tzAccountBrowser', 'tzModelNetwork'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const accountBrowser = ctx.tzAccountBrowser;
        const { dataDir, emit } = ctx.tzDesktop;
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
