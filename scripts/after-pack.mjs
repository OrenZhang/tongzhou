import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Chromium picks the ozone platform before the JS main script runs, so the X11
// pin must reach the real binary as a command-line argument. AppImage's AppRun
// is a fixed template and the .deb desktop entry only covers menu launches;
// renaming the Electron binary and installing a wrapper covers every entry
// point (AppImage direct run, desktop entry, direct binary invocation), and
// app.relaunch() keeps working because it reuses the current argv.
const wrapper = `#!/usr/bin/env bash
# Tongzhou Linux launcher: pin Electron to X11/XWayland (computer control talks
# to the X server). Explicit --ozone-platform flags and
# ELECTRON_OZONE_PLATFORM_HINT always win.
set -e
DIR="\$(cd "\$(dirname "\$(readlink -f "\$0")")" && pwd)"
if [ -n "\$ELECTRON_OZONE_PLATFORM_HINT" ]; then
  exec "\$DIR/tongzhou.bin" "\$@"
fi
for arg in "\$@"; do
  case "\$arg" in
    --ozone-platform|--ozone-platform=*)
      exec "\$DIR/tongzhou.bin" "\$@"
      ;;
  esac
done
exec "\$DIR/tongzhou.bin" --ozone-platform=x11 "\$@"
`;

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const executable = path.join(context.appOutDir, 'tongzhou');
  await rename(executable, `${executable}.bin`);
  await writeFile(executable, wrapper, { mode: 0o755 });
}
