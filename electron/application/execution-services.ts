import { createDomainServices } from '../modules/domain-services';
import { createTaskSystem } from './task-system';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ensureBuiltinPlugins } from '../modules/plugins/builtin-plugins';
import { McpAuth } from '../modules/plugins/mcp-auth';
import { ensureBuiltinSkills } from '../modules/plugins/skills';
import { GitRepositories } from '../modules/projects/git-repositories';
import { Worktrees } from '../modules/projects/worktrees';
import { Connectors } from '../services/accounts/connectors';
import { Bots } from '../services/channels/bots';
import { Channels } from '../services/channels/channels';
import { Feishu } from '../services/channels/feishu';
import { NetworkProfiles } from '../services/network/network-profiles';
import { applyPendingRestore } from '../services/storage/data-maintenance';
import { Store } from '../services/storage/store';
import type { Plugin } from 'cordis';
import type { ApplicationKernel } from './kernel';
import './execution-context';

export function executionServices(kernel: ApplicationKernel): Plugin.Object<void>[] {
  return [
    {
      name: 'tongzhou-storage-service',
      inject: ['tzEnvironment'],
      apply(ctx) {
        const { dataDir, bundleDir } = ctx.tzEnvironment;
        applyPendingRestore(dataDir);
        const require = createRequire(path.join(bundleDir, '../package.json'));
        const store = new Store(
          path.join(dataDir, 'tongzhou.db'),
          ctx.tzEnvironment.createSecretCodec(),
        );
        kernel.own(ctx, async () => {
          store.close();
        });
        ctx.provide('tzStore', store);
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
      inject: ['tzStore', 'tzEnvironment'],
      apply(ctx) {
        const domains = createDomainServices(ctx.tzStore, ctx.tzEnvironment.dataDir);
        ctx.provide('tzKnowledge', domains.knowledge);
        ctx.provide('tzContent', domains.content);
        ctx.provide('tzCanvases', domains.canvases);
        ctx.provide('tzCanvasWorkflows', domains.canvasWorkflows);
        ctx.provide('tzArtifacts', domains.artifacts);
        ctx.provide('tzAttachments', domains.attachments);
        ctx.provide('tzMemories', domains.memories);
        ctx.provide('tzCheckpoints', domains.checkpoints);
      },
    },
    {
      name: 'tongzhou-network-service',
      inject: ['tzEnvironment', 'tzStore', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const { dataDir } = ctx.tzEnvironment;
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
          path
            .join(ctx.tzEnvironment.bundleDir, 'network-core-host.cjs')
            .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
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

        ctx.provide('tzModelNetwork', {
          resolve: (network, runId) => networks.resolve(network, runId),
          transport: ctx.tzEnvironment.modelTransport,
        });
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
      inject: ['tzEnvironment', 'tzStore', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const { dataDir } = ctx.tzEnvironment;
        const worktrees = new Worktrees(store, dataDir, events.changed);
        const repositories = new GitRepositories(store, dataDir, events.changed);
        ctx.provide('tzProjectTools', { worktrees, repositories, activity: { count: 0 } });
      },
    },
    {
      name: 'tongzhou-task-services',
      inject: [
        'tzEnvironment',
        'tzStore',
        'tzCommands',
        'tzEvents',
        'tzModelNetwork',
        'tzProjectTools',
        'tzKnowledge',
        'tzContent',
        'tzCanvases',
        'tzCanvasWorkflows',
        'tzArtifacts',
        'tzAttachments',
        'tzMemories',
        'tzCheckpoints',
      ],
      async apply(ctx) {
        const { dataDir, computer } = ctx.tzEnvironment;
        const system = await createTaskSystem(
          ctx.tzStore,
          dataDir,
          ctx.tzEvents,
          {
            knowledge: ctx.tzKnowledge,
            content: ctx.tzContent,
            canvases: ctx.tzCanvases,
            canvasWorkflows: ctx.tzCanvasWorkflows,
            artifacts: ctx.tzArtifacts,
            attachments: ctx.tzAttachments,
            memories: ctx.tzMemories,
            checkpoints: ctx.tzCheckpoints,
          },
          ctx.tzModelNetwork,
          computer,
          ctx.tzCommands,
          (id) => ctx.tzProjectTools.worktrees.isRemoving(id),
          ctx.tzEnvironment.bundleDir,
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
      inject: ['tzEnvironment', 'tzStore', 'tzEvents'],
      apply(ctx) {
        const store = ctx.tzStore;
        const events = ctx.tzEvents;
        const mcpAuth = new McpAuth(store, events.changed, (url) =>
          ctx.tzEnvironment.host.documents.openExternal(url),
        );
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
  ];
}
