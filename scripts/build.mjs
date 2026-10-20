import { build as esbuild } from 'esbuild';
import path from 'node:path';
import { cp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import './prepare-pty.mjs';
import './prepare-x11.mjs';
// Bundled libraries are build dependencies; only external modules ship in node_modules.
const libraries = new Set();
async function build(options) {
  const result = await esbuild({ ...options, metafile: true });
  for (const input of Object.keys(result.metafile.inputs)) {
    const root = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1];
    if (root) libraries.add(root);
  }
}
await rm('dist-electron', { recursive: true, force: true });
await mkdir('dist-electron/skills', { recursive: true });
await cp('skills', 'dist-electron/skills', { recursive: true });
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
await build({
  entryPoints: [
    'electron/services/desktop/windows-lid-host.ts',
    'electron/services/desktop/macos-lid-host.ts',
  ],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

// Preserve bundled dependencies' notices after removing their duplicate source trees.
const notices = [];
for (const root of [...libraries].sort()) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const files = (await readdir(root)).filter((name) =>
    /^(licen[cs]e|notice|copying)(\.|$)/i.test(name),
  );
  const texts = await Promise.all(files.map((name) => readFile(path.join(root, name), 'utf8')));
  notices.push(
    `${pkg.name}@${pkg.version} (${typeof pkg.license === 'string' ? pkg.license : 'see upstream license'})\n${texts.join('\n')}`,
  );
}
await writeFile('dist-electron/THIRD_PARTY_LICENSES.txt', notices.join('\n\n---\n\n'));
