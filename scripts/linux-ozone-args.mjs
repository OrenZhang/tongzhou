// Computer control talks to the X server (libX11/libXtst), so every Linux launch
// (packaged builds via build.linux.executableArgs, dev via start.mjs/dev.mjs) must
// reach Electron as a real command-line argument: Chromium reads the ozone platform
// before the JS main script runs, so app.commandLine.appendSwitch is too late there.
// An explicit --ozone-platform flag or ELECTRON_OZONE_PLATFORM_HINT always wins.
export function linuxOzoneArgs(
  platform = process.platform,
  env = process.env,
  argv = process.argv,
) {
  if (platform !== 'linux') return [];
  if (env.ELECTRON_OZONE_PLATFORM_HINT) return [];
  if (argv.some((arg) => arg.startsWith('--ozone-platform'))) return [];
  return ['--ozone-platform=x11'];
}
