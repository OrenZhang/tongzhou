import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import './prepare-pty.mjs';
await mkdir('dist-electron/skills', { recursive: true });
await cp('skills/skill-creator', 'dist-electron/skills/skill-creator', { recursive: true });
await build({
  entryPoints: ['electron/services/network/node-request-identity.ts'],
  outfile: 'dist-electron/node-request-identity.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
await build({
  entryPoints: ['electron/services/network/network-core-host.ts'],
  outfile: 'dist-electron/network-core-host.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
await build({
  entryPoints: ['electron/main.ts'],
  define: {
    __TONGZHOU_GITHUB_CLIENT_ID__: JSON.stringify(process.env.TONGZHOU_GITHUB_CLIENT_ID || ''),
  },
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'electron-updater', '@openai/codex', 'node:sqlite'],
  sourcemap: true,
});
await build({
  entryPoints: ['electron/preload.ts', 'electron/permission-panel-preload.ts'],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  target: 'node22',
});

await build({
  entryPoints: ['electron/core/tools/tool-proxy.ts'],
  outfile: 'dist-electron/tool-proxy.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
await build({
  entryPoints: ['electron/modules/plugins/builtin-mcp.ts'],
  outfile: 'dist-electron/builtin-mcp.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

await build({
  entryPoints: ['electron/services/desktop/terminal-host.ts'],
  outfile: 'dist-electron/terminal-host.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node-pty'],
});
