import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'cordis';
import type { ApplicationKernel } from './kernel';
import type { ExecutionEnvironment } from './execution-context';
import { PowerSettings, type PowerDriver } from '../services/desktop/power';
import { LidProcess } from '../services/desktop/lid-process';
import { macLidDirectory } from '../services/desktop/macos-lid-script';
import type { PowerPreferences } from '../../src/shared/power';
import { Updates, type UpdateDriver } from '../services/desktop/updates';
import './execution-context';
export type PowerSource = Pick<
  PowerDriver,
  'platform' | 'supported' | 'onBatteryPower' | 'startBlocker' | 'stopBlocker' | 'blockerActive'
> & { watch(changed: (battery: boolean) => void): () => void };
export function powerService(
  kernel: ApplicationKernel,
  create: (environment: ExecutionEnvironment) => PowerSource | Promise<PowerSource>,
): Plugin.Object<void> {
  return {
    name: 'tongzhou-power-service',
    inject: ['tzStore', 'tzEnvironment'],
    async apply(ctx) {
      const { bundleDir, dataDir, emit } = ctx.tzEnvironment;
      const source = await create(ctx.tzEnvironment);
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
          ...source,
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
      const unwatch = source.watch((battery) => {
        void power.refresh(battery);
      });
      kernel.own(ctx, async () => {
        unwatch();
        await power.dispose();
      });
      ctx.provide('tzPower', power);
      // macOS authorization is user initiated; never block startup on a password dialog.
      await power.refresh();
      if (process.platform === 'darwin' && existsSync(macLidDirectory + '/original'))
        power.reportLidError('检测到未恢复的合盖设置，请点击重试并完成管理员授权');
    },
  };
}
export function updateService(
  kernel: ApplicationKernel,
  create: (environment: ExecutionEnvironment) => {
    driver: UpdateDriver;
    packaged: boolean;
    automaticInstall: boolean;
    unavailableReason?: string;
    dispose?(): void;
  },
): Plugin.Object<void> {
  return {
    name: 'tongzhou-updates-service',
    inject: ['tzEnvironment', 'tzStore'],
    apply(ctx) {
      const source = create(ctx.tzEnvironment),
        store = ctx.tzStore;
      const updates = new Updates(
        source.driver,
        ctx.tzEnvironment.host.version,
        source.packaged,
        source.automaticInstall,
        () =>
          store.list<any>('run').some((r) => r.status === 'running') ||
          store.list<any>('terminal').some((t) => t.status === 'running') ||
          store.list<any>('pendingInput').some((p) => ['queued', 'dispatching'].includes(p.status)),
        (state) => ctx.tzEnvironment.emit({ type: 'update', state }),
        source.unavailableReason,
      );
      kernel.own(ctx, () => {
        updates.dispose();
        source.dispose?.();
      });
      ctx.provide('tzUpdates', updates);
    },
  };
}
