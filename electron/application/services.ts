import { app, powerMonitor, powerSaveBlocker } from 'electron';
import { PowerSettings } from '../services/desktop/power';
import { LidProcess } from '../services/desktop/lid-process';
import type { PowerPreferences } from '../../src/shared/power';
import { autoUpdater } from 'electron-updater';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { macLidDirectory } from '../services/desktop/macos-lid-script';
import path from 'node:path';
import type { Provider } from '../../src/shared/types';
import { AccountBrowser } from '../services/accounts/account-browser';
import { Accounts } from '../services/accounts/accounts';
import { Updates } from '../services/desktop/updates';
import type { Plugin } from 'cordis';
import type { ApplicationKernel } from './kernel';
import './context';

export function desktopServices(kernel: ApplicationKernel): Plugin.Object<void>[] {
  return [
    {
      name: 'tongzhou-power-service',
      inject: ['tzStore', 'tzDesktop'],
      async apply(ctx) {
        const { bundleDir, dataDir, emit } = ctx.tzDesktop;
        const store = ctx.tzStore;
        const require = createRequire(path.join(bundleDir, '../package.json'));
        const nodeRoot = path
          .dirname(require.resolve('node/package.json'))
          .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
        const lid = new LidProcess(
          path.join(nodeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
          bundleDir,
          dataDir,
          (message) => power.reportLidError(message),
        );
        const saved = store
          .list<PowerPreferences & { id: string }>('preferences')
          .find((item) => item.id === 'power');
        const power = new PowerSettings(
          {
            platform: process.platform,
            supported: ['win32', 'darwin'].includes(process.platform),
            onBatteryPower: () => powerMonitor.isOnBatteryPower(),
            startBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
            stopBlocker: (id) => {
              powerSaveBlocker.stop(id);
            },
            setLidEnabled: (enabled, interactive) => lid.setEnabled(enabled, interactive),
          },
          {
            keepAwakeOnAC: saved?.keepAwakeOnAC === true,
            keepAwakeWhenLidClosed:
              process.platform !== 'darwin' && saved?.keepAwakeWhenLidClosed === true,
          },
          (value) => store.put('preferences', { id: 'power', ...value }),
          (state) => emit({ type: 'power', state }),
        );
        const onAC = () => {
          void power.refresh(false);
        };
        const onBattery = () => {
          void power.refresh(true);
        };
        const onResume = () => {
          void power.refresh();
        };
        powerMonitor.on('on-ac', onAC);
        powerMonitor.on('on-battery', onBattery);
        powerMonitor.on('resume', onResume);
        kernel.own(ctx, async () => {
          powerMonitor.removeListener('on-ac', onAC);
          powerMonitor.removeListener('on-battery', onBattery);
          powerMonitor.removeListener('resume', onResume);
          await power.dispose();
        });
        ctx.provide('tzPower', power);
        // macOS authorization is user initiated; never block startup on a password dialog.
        await power.refresh();
        if (process.platform === 'darwin' && existsSync(macLidDirectory + '/original'))
          power.reportLidError('检测到未恢复的合盖设置，请点击重试并完成管理员授权');
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
