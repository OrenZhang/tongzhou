import { electronComputerDiagnostic } from '../services/desktop/electron-computer';
import { app, clipboard, dialog, session, nativeTheme } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DesktopEnvironment } from './context';
import type { ExecutionEnvironment } from './execution-context';
import { desktopDocumentHost } from '../services/desktop/document-host';
import { writeClipboardText } from '../services/desktop/clipboard';
import { createSecretCodec } from '../services/desktop/secret-store';
import { accountProxyConfig } from '../services/network/provider-network';
import { userAgent } from '../services/network/request-identity';
import { setServiceTransport } from '../services/network/service-network';

/** Chromium networking, native UI and legacy credentials remain owned by Electron. */
export function desktopHost(desktop: DesktopEnvironment) {
  const modelTransports = new Map<string, Promise<typeof fetch>>();
  const require = createRequire(path.join(desktop.bundleDir, '../package.json'));
  const environment: ExecutionEnvironment = {
    dataDir: desktop.dataDir,
    bundleDir: desktop.bundleDir,
    emit: desktop.emit,
    computer: desktop.computer,
    pendingImports: desktop.pendingImports,
    createSecretCodec: () =>
      createSecretCodec(desktop.dataDir, process.platform, () => require('electron').safeStorage),
    host: {
      version: app.getVersion(),
      computer: {
        controller: desktop.computer,
        guide: () => desktop.computerPermissions.guide(),
        openSettings: (permission) => desktop.computerPermissionPanel.open(permission),
        reveal: () => desktop.computerPermissions.revealApplication(),
        diagnostic: () => electronComputerDiagnostic(desktop.computer),
      },
      setTheme(theme) {
        nativeTheme.themeSource = theme;
        desktop
          .getWindow()
          ?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#17191e' : '#fafbfc');
      },
      documents: desktopDocumentHost,
      dialogs: {
        showOpenDialog(options) {
          const window = desktop.getWindow();
          return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
        },
        showSaveDialog(options) {
          const window = desktop.getWindow();
          return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
        },
      },
      writeClipboard: (text) => writeClipboardText(clipboard, text),
      restart() {
        app.relaunch();
        app.quit();
      },
    },
    async networkProbe(id, network) {
      const isolated = session.fromPartition('tongzhou-network-test-' + id);
      await isolated.setProxy(accountProxyConfig(network));
      await isolated.closeAllConnections();
      return ((input, init) => isolated.fetch(input as string, init)) as typeof fetch;
    },
    modelTransport(network) {
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
    },
  };
  const updateWindowTheme = () =>
    desktop
      .getWindow()
      ?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#17191e' : '#fafbfc');
  return {
    environment,
    connect() {
      nativeTheme.on('updated', updateWindowTheme);
      const serviceSession = session.fromPartition('tongzhou-service-network');
      setServiceTransport((input, init) =>
        serviceSession.fetch(input instanceof URL ? input.href : input, {
          ...init,
          bypassCustomProtocolHandlers: true,
        }),
      );
    },
    dispose() {
      nativeTheme.removeListener('updated', updateWindowTheme);
      modelTransports.clear();
      setServiceTransport();
    },
  };
}
