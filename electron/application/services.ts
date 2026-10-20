import { app, powerMonitor, powerSaveBlocker } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AccountBrowser } from '../services/accounts/account-browser';
import { accountServices } from './account-services';
import { powerService, updateService } from './system-services';
import type { Plugin } from 'cordis';
import type { ApplicationKernel } from './kernel';
import './context';
export function desktopServices(kernel: ApplicationKernel): Plugin.Object<void>[] {
  return [
    powerService(kernel, () => ({
      platform: process.platform,
      supported: ['win32', 'darwin'].includes(process.platform),
      onBatteryPower: () => powerMonitor.isOnBatteryPower(),
      startBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
      stopBlocker: (id) => {
        powerSaveBlocker.stop(id);
      },
      watch(changed) {
        const ac = () => changed(false),
          battery = () => changed(true),
          resume = () => changed(powerMonitor.isOnBatteryPower());
        powerMonitor.on('on-ac', ac);
        powerMonitor.on('on-battery', battery);
        powerMonitor.on('resume', resume);
        return () => {
          powerMonitor.off('on-ac', ac);
          powerMonitor.off('on-battery', battery);
          powerMonitor.off('resume', resume);
        };
      },
    })),
    updateService(kernel, (environment) => {
      const require = createRequire(path.join(environment.bundleDir, '../package.json'));
      return {
        driver: autoUpdater,
        packaged: app.isPackaged && ['win32', 'darwin'].includes(process.platform),
        automaticInstall:
          process.platform === 'win32' ||
          require(path.join(app.getAppPath(), 'package.json')).tongzhouMacAutoUpdate === true,
      };
    }),
    ...accountServices(kernel, (store, resolve) => new AccountBrowser(store, resolve)),
  ];
}
