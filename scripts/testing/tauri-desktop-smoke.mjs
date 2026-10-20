import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/tauri-desktop-'));
async function run(program, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(program)} exited ${code}`)),
    );
  });
}
// CLI output may contain the disposable private key; do not forward it to reports or logs.
async function signer(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/@tauri-apps/cli/tauri.js', 'signer', ...args],
      { stdio: 'ignore' },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Fixture signer failed')),
    );
  });
}
await signer(['generate', '--ci', '-p', '', '-w', path.join(root, 'key')]);
await chmod(path.join(root, 'key'), 0o600);
await writeFile(path.join(root, 'payload'), 'TONGZHOU SIGNED UPDATE FIXTURE');
await signer([
  'sign',
  '-f',
  path.join(root, 'key'),
  '-p',
  '',
  '--app-version',
  '2.0.0',
  path.join(root, 'payload'),
]);
await run(process.execPath, [
  'node_modules/vitest/vitest.mjs',
  'run',
  'tests/hosts/tauri-desktop.test.ts',
  'tests/services/desktop/power.test.ts',
  'tests/services/desktop/computer.test.ts',
  'tests/services/desktop/updates.test.ts',
]);
const cargo = path.resolve('work/toolchains/cargo');
const local = existsSync(path.join(cargo, 'bin/cargo'));
await run(
  local ? path.join(cargo, 'bin/cargo') : 'cargo',
  ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--include-ignored'],
  {
    ...(local ? { CARGO_HOME: cargo, RUSTUP_HOME: path.resolve('work/toolchains/rustup') } : {}),
    TONGZHOU_TEST_UPDATE_DIR: root,
  },
);
await writeFile(
  path.join(root, 'report.json'),
  JSON.stringify(
    {
      sharedPowerAndComputerRules: true,
      nativeUpdateAdapter: true,
      signedDownload: true,
      tamperedDownloadRejected: true,
      signedVersionReplayRejected: true,
      installerExecuted: false,
      productionCredentialsUsed: false,
    },
    null,
    2,
  ),
);
console.log('Tauri desktop boundaries passed:', root);
