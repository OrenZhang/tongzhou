import { build } from 'esbuild';
await build({
  entryPoints: ['electron/node-request-identity.ts'],
  outfile: 'dist-electron/node-request-identity.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
await build({
  entryPoints: ['electron/network-core-host.ts'],
  outfile: 'dist-electron/network-core-host.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
await build({
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', '@openai/codex', 'node:sqlite'],
  sourcemap: true,
});
await build({
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  target: 'node22',
});

await build({
  entryPoints: ['electron/tool-proxy.ts'],
  outfile: 'dist-electron/tool-proxy.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
await build({
  entryPoints: ['electron/builtin-mcp.ts'],
  outfile: 'dist-electron/builtin-mcp.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

await build({
  entryPoints: ['electron/terminal-host.ts'],
  outfile: 'dist-electron/terminal-host.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node-pty'],
});
