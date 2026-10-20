import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ComputerControl } from '../services/desktop/computer';
import { computerHelper } from '../services/desktop/computer-helper';
import {
  permissionPanelBounds,
  permissionPanelHTML,
} from '../services/desktop/permission-panel-view';
import { computerDiagnostic } from '../services/desktop/computer-diagnostic';
import { x11Available } from '../services/desktop/linux-computer';
import { powerService, updateService } from '../application/system-services';
import { powerPlugin } from '../application/features/power';
import { updatesPlugin } from '../application/features/updates';
import { computerPlugin } from '../application/features/computer';
import type { ApplicationKernel } from '../application/kernel';
import type { ApplicationHost } from '../application/host';
import type { ComputerStatus } from '../../src/shared/types';
import type { UpdateDriver } from '../services/desktop/updates';

export type NativeCall = <T = any>(method: string, ...args: unknown[]) => Promise<T>;
/** Translate native updater results only; policy, busy guards and UI state remain in Updates. */
export function nativeUpdateDriver(native: NativeCall, events: EventEmitter) {
  const driver = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    async checkForUpdates() {
      const update = await native('updateCheck');
      driver.emit(update ? 'update-available' : 'update-not-available', update);
    },
    async downloadUpdate() {
      await native('updateDownload');
      driver.emit('update-downloaded');
    },
    async quitAndInstall() {
      await native('updateInstall');
    },
  }) satisfies UpdateDriver;
  const progress = (value: { percent: number }) => driver.emit('download-progress', value);
  events.on('updateProgress', progress);
  return {
    driver,
    dispose() {
      events.off('updateProgress', progress);
      driver.removeAllListeners();
    },
  };
}
export function tauriDesktop(native: NativeCall, events: EventEmitter) {
  let status: ComputerStatus = {
    supported: false,
    platform: process.platform,
    screen: 'denied',
    accessibility: false,
    emergencyShortcut: false,
  };
  let configured = false;
  const controller = new ComputerControl({
    status: () => status,
    async refresh() {
      status = await native('computerStatus');
      if (process.platform === 'linux') status.supported = x11Available();
    },
    requestPermission: () =>
      status.platform === 'darwin' ? computer.openSettings('accessibility') : Promise.resolve(),
    async helper(payload: any, signal) {
      if (process.platform !== 'darwin' || payload.action !== 'type')
        return computerHelper(payload, signal, (text) => native('clipboard', text));
      await computerHelper({ action: 'focus', window: payload.window }, signal);
      const characters = Array.from(payload.text as string);
      for (let i = 0; i < characters.length; i += 32) {
        signal.throwIfAborted();
        await native(
          'computerType',
          payload.window.id,
          payload.window.pid,
          payload.window.title,
          characters.slice(i, i + 32).join(''),
        );
      }
      return { ok: true };
    },
    async capture(window, signal) {
      signal.throwIfAborted();
      const image = await native('computerCapture', window.id, window.pid);
      signal.throwIfAborted();
      return image;
    },
  });
  const computer: NonNullable<ApplicationHost['computer']> = {
    controller,
    async guide() {
      if (process.platform !== 'darwin') return null;
      const guide = await native('computerApplication');
      const icon = await readFile(path.join(__dirname, '../build/icon.png'));
      return {
        name: path.basename(guide.path),
        path: guide.path,
        development: guide.development,
        icon: 'data:image/png;base64,' + icon.toString('base64'),
      };
    },
    async openSettings(permission) {
      await native('computerSettings', permission);
      const guide = await computer.guide();
      if (!guide) return;
      let placement = await native('permissionGeometry');
      for (let attempt = 0; !placement.settings && attempt < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        placement = await native('permissionGeometry');
      }
      const { settings, area } = placement;
      await native(
        'permissionPanel',
        permissionPanelHTML(guide, permission).replace(
          'img-src data:;',
          'connect-src ipc: http://ipc.localhost; img-src data:;',
        ),
        permissionPanelBounds(settings, area),
      );
    },
    reveal: () => native('computerReveal'),
    diagnostic: () =>
      computerDiagnostic(controller, async (title, signal) => {
        const { pid } = await native('diagnosticOpen', title);
        try {
          for (let attempt = 0; attempt < 40; attempt++) {
            signal.throwIfAborted();
            if ((await native('diagnosticRead')) === 'ready') break;
            if (attempt === 39) throw new Error('自检窗口加载超时');
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error) {
          await native('diagnosticClose');
          throw error;
        }
        const close = () => {
          void native('diagnosticClose').catch(() => {});
        };
        signal.addEventListener('abort', close, { once: true });
        return {
          pid,
          read: async () => {
            const value = await native('diagnosticRead');
            return value === 'ready' ? '' : decodeURIComponent(value);
          },
          async close() {
            signal.removeEventListener('abort', close);
            await native('diagnosticClose');
          },
        };
      }),
  };
  return {
    computer,
    features: [powerPlugin, updatesPlugin, computerPlugin],
    async prepare() {
      configured = (await native('desktopInfo')).updatesConfigured;
      await controller.refresh();
      controller.emergencyShortcut = status.emergencyShortcut;
    },
    services(kernel: ApplicationKernel) {
      return [
        powerService(kernel, async () => {
          const initial = await native('powerStatus');
          let battery = initial.onBatteryPower,
            active = initial.active;
          let pending: Promise<unknown> = Promise.resolve();
          const powerCall = <T>(method: string, ...args: unknown[]) => {
            const work = pending.then(() => native<T>(method, ...args));
            pending = work.catch(() => {});
            return work;
          };
          return {
            platform: process.platform,
            supported: ['darwin', 'win32'].includes(process.platform),
            onBatteryPower: () => battery,
            blockerActive: () => active,
            async startBlocker() {
              const id = await powerCall<number>('powerStart');
              active = true;
              return id;
            },
            async stopBlocker(id) {
              await powerCall<void>('powerStop', id);
              active = false;
            },
            watch(changed) {
              let closed = false,
                polling = false;
              const timer = setInterval(async () => {
                if (polling || closed) return;
                polling = true;
                try {
                  const current = await native('powerStatus');
                  battery = current.onBatteryPower;
                  active = current.active;
                  if (!closed) changed(battery);
                } catch {
                  battery = true;
                  if (!closed) changed(true);
                } finally {
                  polling = false;
                }
              }, 2000);
              timer.unref();
              return () => {
                closed = true;
                clearInterval(timer);
              };
            },
          };
        }),
        updateService(kernel, () => ({
          ...nativeUpdateDriver(native, events),
          packaged: configured,
          automaticInstall: configured,
          unavailableReason: 'Tauri 预览尚未配置更新签名公钥。发布时需生成并签名专用更新包。',
        })),
      ];
    },
  };
}
