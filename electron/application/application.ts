import { ipcMain } from 'electron';
import { ExecutionApplication } from './execution-application';
import { ClientIpc } from './client-ipc';
import { desktopHost } from './desktop-host';
import type { DesktopEnvironment } from './context';
import { desktopServices } from './services';
import { desktopFeatures } from './features';

/** Desktop composition adds only Electron services and an authenticated IPC adapter. */
export class DesktopApplication extends ExecutionApplication {
  constructor(desktop: DesktopEnvironment) {
    const host = desktopHost(desktop);
    super(host.environment, {
      commands: (catalog, accepting) =>
        new ClientIpc(catalog, ipcMain, desktop.getWindow, desktop.trusted, accepting),
      setup: {
        name: 'tongzhou-electron-host',
        apply(ctx) {
          ctx.provide('tzDesktop', desktop);
          ctx.effect(() => {
            host.connect();
            return host.dispose;
          });
          ctx.effect(() => () => {
            desktop.computerPermissionPanel.close();
            desktop.pendingImports.clear();
          });
        },
      },
      services: desktopServices,
      features: desktopFeatures,
    });
  }
}
