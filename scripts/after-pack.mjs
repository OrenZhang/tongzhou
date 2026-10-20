import { rename, writeFile, readdir, rm } from 'node:fs/promises';
import { Arch } from 'builder-util';
import path from 'node:path';

// Chromium picks the ozone platform before the JS main script runs, so the X11
// pin must reach the real binary as a command-line argument. AppImage's AppRun
// is a fixed template and the .deb desktop entry only covers menu launches;
// renaming the Electron binary and installing a wrapper covers every entry
// point (AppImage direct run, desktop entry, direct binary invocation), and
// app.relaunch() keeps working because it reuses the current argv.
const wrapper = `#!/usr/bin/env bash
# CoSail Linux launcher: pin Electron to X11/XWayland (computer control talks
# to the X server). Explicit --ozone-platform flags and
# ELECTRON_OZONE_PLATFORM_HINT always win.
set -e
DIR="\$(cd "\$(dirname "\$(readlink -f "\$0")")" && pwd)"
if [ -n "\$ELECTRON_OZONE_PLATFORM_HINT" ]; then
  exec "\$DIR/cosail.bin" "\$@"
fi
for arg in "\$@"; do
  case "\$arg" in
    --ozone-platform|--ozone-platform=*)
      exec "\$DIR/cosail.bin" "\$@"
      ;;
  esac
done
exec "\$DIR/cosail.bin" --ozone-platform=x11 "\$@"
`;

export default async function afterPack(context) {
  // Runtime selection uses process.platform/process.arch. Keep the complete
  // target prebuild (including spawn-helper/ConPTY), prune only other targets.
  const prebuilds = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    'app.asar.unpacked/node_modules/node-pty/prebuilds',
  );
  const architectures =
    Arch[context.arch] === 'universal' ? ['arm64', 'x64'] : [Arch[context.arch]];
  const keep = new Set(architectures.map((arch) => `${context.electronPlatformName}-${arch}`));
  const entries = await readdir(prebuilds, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries)
    if (entry.isDirectory() && /^(darwin|win32|linux)-/.test(entry.name) && !keep.has(entry.name))
      await rm(path.join(prebuilds, entry.name), { recursive: true });
  if (context.electronPlatformName !== 'linux') return;
  const executable = path.join(context.appOutDir, 'cosail');
  await rename(executable, `${executable}.bin`);
  await writeFile(executable, wrapper, { mode: 0o755 });
}
