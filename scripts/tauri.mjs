import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { listPackage, statFile, extractFile } from '@electron/asar';

const root = process.cwd(),
  command = process.argv[2] ?? 'build';
const run = (program, args, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`)),
    );
  });
const require = createRequire(import.meta.url);
const localCargo = path.join(root, 'work/toolchains/cargo');
const rust = existsSync(path.join(localCargo, 'bin/cargo'))
  ? {
      CARGO_HOME: localCargo,
      RUSTUP_HOME: path.join(root, 'work/toolchains/rustup'),
      PATH: path.join(localCargo, 'bin') + path.delimiter + process.env.PATH,
    }
  : {};
const platformDirectory =
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'mac-arm64'
      : 'mac'
    : process.platform === 'win32'
      ? 'win-unpacked'
      : process.arch === 'x64'
        ? 'linux-unpacked'
        : `linux-${process.arch}-unpacked`;
const baseline = path.resolve('work/tauri-electron-baseline');
const app =
  process.platform === 'darwin'
    ? path.join(baseline, platformDirectory, 'CoSail.app')
    : path.join(baseline, platformDirectory);
const resources =
  process.platform === 'darwin'
    ? path.join(app, 'Contents/Resources')
    : path.join(app, 'resources');
const runtime = path.resolve('work/tauri-runtime');
if (command === 'prepare' || command === 'build') {
  if (!process.argv.includes('--reuse-baseline')) {
    await run(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit']);
    await run(process.execPath, ['scripts/icon.mjs']);
    await run(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'build']);
    await run(process.execPath, ['scripts/build.mjs']);
    await run(
      process.execPath,
      [
        require.resolve('electron-builder/cli.js'),
        '--dir',
        '--publish',
        'never',
        `--config.electronDist=${path.resolve('node_modules/electron/dist')}`,
        `--config.directories.output=${baseline}`,
      ],
      { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    );
  }
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  // Use the exact same tested dependency collector and pruning as Electron.
  const archive = path.join(resources, 'app.asar');
  await cp(path.join(resources, 'app.asar.unpacked'), runtime, {
    recursive: true,
    verbatimSymlinks: true,
  });
  // afterPack removes non-target PTY files; obsolete unpacked header entries are not resources.
  for (const entry of listPackage(archive)) {
    const name = entry.replace(/^[/\\]+/, '');
    const info = statFile(archive, name, false);
    if (info.files || info.unpacked) continue;
    const target = path.join(runtime, name);
    await mkdir(path.dirname(target), { recursive: true });
    if (info.link)
      await symlink(path.relative(path.dirname(target), path.join(runtime, info.link)), target);
    else
      await writeFile(target, extractFile(archive, name), {
        mode: info.executable ? 0o755 : 0o644,
      });
  }
  await rm(path.join(runtime, 'dist'), { recursive: true, force: true });
  for (const name of ['main.cjs', 'main.cjs.map', 'preload.cjs', 'permission-panel-preload.cjs'])
    await rm(path.join(runtime, 'dist-electron', name), { force: true });
  const result = await build({
    entryPoints: ['electron/hosts/tauri.ts'],
    outfile: path.join(runtime, 'dist-electron/tauri-host.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    metafile: true,
    define: {
      __TONGZHOU_GITHUB_CLIENT_ID__: JSON.stringify(process.env.TONGZHOU_GITHUB_CLIENT_ID || ''),
    },
    external: ['@openai/codex'],
    plugins: [
      {
        name: 'no-electron',
        setup(build) {
          build.onResolve({ filter: /^(electron|electron-updater)(\/|$)/ }, (args) => {
            throw new Error(`Node host imports ${args.path}`);
          });
        },
      },
    ],
  });
  const libraries = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const pkg = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1];
    if (pkg) libraries.add(pkg);
  }
  const notices = [];
  for (const directory of [...libraries].sort()) {
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory)).filter((name) =>
      /^(licen[cs]e|notice|copying)(\.|$)/i.test(name),
    );
    const texts = await Promise.all(
      files.map((name) => readFile(path.join(directory, name), 'utf8')),
    );
    notices.push(`${pkg.name}@${pkg.version}\n${texts.join('\n')}`);
  }
  await writeFile(
    path.join(runtime, 'dist-electron/THIRD_PARTY_LICENSES.txt'),
    notices.join('\n\n'),
  );
  await run(process.execPath, [
    path.resolve('node_modules/vite/bin/vite.js'),
    'build',
    '--mode',
    'tauri',
    '--outDir',
    'dist-tauri',
  ]);
  await cp('NOTICE', path.join(runtime, 'NOTICE'));
  console.log('Prepared shared Node runtime:', runtime);
}
if (command === 'build') {
  const updater = process.argv.includes('--updater');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const file = path.resolve('work/tauri-build-config.json');
  const overrides = { version };
  const config = ['--config', file];
  if (updater) {
    if (
      !process.env.TONGZHOU_TAURI_UPDATER_PUBLIC_KEY?.trim() ||
      !process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()
    )
      throw new Error(
        '--updater requires TONGZHOU_TAURI_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY',
      );
    overrides.bundle = { createUpdaterArtifacts: true };
  }
  await writeFile(file, JSON.stringify(overrides));
  // Resources are collected for the native host architecture, never a different Rust target.
  if (process.argv.some((arg) => arg === '--target' || arg.startsWith('--target=')))
    throw new Error('Tauri runtime staging currently requires a native architecture build');
  await run(
    process.execPath,
    [
      path.resolve('node_modules/@tauri-apps/cli/tauri.js'),
      'build',
      '--bundles',
      process.platform === 'darwin' ? 'app' : process.platform === 'win32' ? 'nsis' : 'appimage',
      ...config,
      ...process.argv.slice(3).filter((arg) => !['--reuse-baseline', '--updater'].includes(arg)),
    ],
    {
      ...rust,
      ...(process.platform === 'darwin'
        ? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:' + (rust.PATH || process.env.PATH) }
        : {}),
      ...(process.platform === 'darwin' && !process.env.APPLE_SIGNING_IDENTITY?.trim()
        ? { APPLE_SIGNING_IDENTITY: '-' }
        : {}),
    },
  );
} else if (command === 'start') {
  const binary =
    process.platform === 'darwin'
      ? 'src-tauri/target/release/bundle/macos/CoSail.app/Contents/MacOS/cosail-preview'
      : 'src-tauri/target/release/cosail-preview' + (process.platform === 'win32' ? '.exe' : '');
  await stat(binary);
  if (process.platform === 'darwin') {
    // LaunchServices attributes privacy permissions to the application, not the parent shell.
    const application = path.resolve(path.dirname(path.dirname(path.dirname(binary))));
    const environment = ['PATH', 'TONGZHOU_TAURI_DATA_DIR', 'TONGZHOU_DISABLE_UPDATES']
      .filter((key) => process.env[key] !== undefined)
      .flatMap((key) => ['--env', `${key}=${process.env[key]}`]);
    await run('/usr/bin/open', ['-W', '-a', application, ...environment]);
  } else await run(path.resolve(binary), []);
} else if (command !== 'prepare') throw new Error('Use prepare, build or start');
