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
