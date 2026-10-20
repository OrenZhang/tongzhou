import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';

await mkdir('test-results', { recursive: true });
const output = 'dist-electron/execution-smoke.cjs';
await build({
  entryPoints: ['scripts/testing/execution-smoke.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['@openai/codex'],
  plugins: [
    {
      name: 'execution-boundary',
      setup(build) {
        build.onResolve({ filter: /^(electron|electron-updater)(\/|$)/ }, (args) => {
          throw new Error(`Execution core imports ${args.path} from ${args.importer}`);
        });
      },
    },
  ],
});
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [output], { stdio: 'inherit', windowsHide: true });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Node execution smoke timed out'));
    }, 90000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
} finally {
  await rm(output, { force: true });
}
