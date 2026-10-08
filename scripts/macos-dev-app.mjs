import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const run = promisify(execFile);

/** Use a separate, consistently named app so Dock and TCC identify this workspace. */
export async function prepareMacDevelopmentApp(executable) {
  if (process.platform !== 'darwin') return executable;
  const root = path.resolve('.');
  const directory = path.join(root, 'work/macos-development');
  const bundle = path.join(directory, '同舟.app');
  const target = path.join(bundle, 'Contents/MacOS/Electron');
  const source = path.dirname(path.dirname(path.dirname(executable)));
  if (!source.endsWith('.app')) throw new Error('Electron runtime is not a macOS app bundle.');
  const icon = await readFile(path.join(root, 'build/icon.icns'));
  const sourcePlist = await readFile(path.join(source, 'Contents/Info.plist'));
  const fingerprint = createHash('sha256')
    .update('tongzhou-dev-app-v1')
    .update(icon)
    .update(sourcePlist)
    .digest('hex');
  const marker = path.join(directory, 'runtime.json');
  try {
    if (JSON.parse(await readFile(marker, 'utf8')).fingerprint === fingerprint) {
      await readFile(path.join(bundle, 'Contents/Info.plist'));
      return target;
    }
  } catch {
    /* Prepare the app on its first launch or after a runtime update. */
  }
  await mkdir(directory, { recursive: true });
  await rm(bundle, { recursive: true, force: true });
  await cp(source, bundle, { recursive: true, verbatimSymlinks: true });
  await writeFile(path.join(bundle, 'Contents/Resources/tongzhou.icns'), icon);
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({
    CFBundleName: '同舟',
    CFBundleDisplayName: '同舟',
    CFBundleIdentifier: 'org.tongzhou.desktop.development',
    CFBundleIconFile: 'tongzhou.icns',
  })) {
    await run('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
  }
  // Keep the changed development bundle valid on Apple Silicon without release credentials.
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  await writeFile(marker, JSON.stringify({ fingerprint }, null, 2));
  return target;
}
