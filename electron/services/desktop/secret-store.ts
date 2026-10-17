import { localSecretCodec } from '../storage/local-secret-codec';
import type { SecretCodec } from '../storage/store';

/**
 * Chromium picks the Linux secret backend from desktop identity variables;
 * WSL and minimal sessions leave them unset and would silently fall back to
 * unencrypted basic_text. Only fill that gap; real desktops are auto-detected
 * and an explicit --password-store flag always wins.
 */
export function linuxPasswordStore(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  argv: string[],
): 'gnome-libsecret' | undefined {
  if (platform !== 'linux') return undefined;
  if (env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP) return undefined;
  if (argv.some((arg) => arg.startsWith('--password-store'))) return undefined;
  return 'gnome-libsecret';
}
/** The factory must stay lazy: obtaining Electron's safeStorage can initialize
 * the OS key provider. macOS must not obtain it, including for legacy records. */
export function createSecretCodec(
  dataDir: string,
  platform: NodeJS.Platform,
  systemStorage: () => typeof import('electron').safeStorage,
): SecretCodec {
  if (platform === 'darwin') return localSecretCodec(dataDir);
  const storage = systemStorage();
  return {
    encrypt(value) {
      if (
        !storage.isEncryptionAvailable() ||
        (platform === 'linux' && storage.getSelectedStorageBackend() === 'basic_text')
      )
        throw new Error('系统安全存储不可用，拒绝明文保存密钥');
      return storage.encryptString(value).toString('base64');
    },
    decrypt(value) {
      if (!storage.isEncryptionAvailable()) throw new Error('系统安全存储不可用');
      return storage.decryptString(Buffer.from(value, 'base64'));
    },
  };
}
