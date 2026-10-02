import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
const output = 'dist-electron/bridge-smoke.cjs';
await build({
  entryPoints: ['scripts/bridge-smoke.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['@openai/codex'],
});
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [output], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(output, { force: true });
}
