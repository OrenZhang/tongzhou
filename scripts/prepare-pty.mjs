import { createRequire } from 'node:module';
import { readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import path from 'node:path';

// node-pty 1.1.0 upstream #850 (helper mode) and #923 (double asar suffix).
// Apply before packaging/signing, never modify an installed signed application.
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('node-pty/package.json'));
const source = path.join(root, 'lib/unixTerminal.js');
let code = await readFile(source, 'utf8');
for (const archive of ['app.asar', 'node_modules.asar']) {
  const old = `helperPath.replace('${archive}', '${archive}.unpacked')`;
  const fixed = `helperPath.replace('${archive}' + path.sep, '${archive}.unpacked' + path.sep)`;
  if (!code.includes(old) && !code.includes(fixed))
    throw new Error('node-pty helper path changed; review the compatibility patch');
  code = code.replace(old, fixed);
}
await writeFile(source, code);
if (process.platform !== 'win32') {
  const prebuilds = path.join(root, 'prebuilds');
  const dirs = (await readdir(prebuilds)).filter((dir) => dir.startsWith(process.platform + '-'));
  for (const dir of dirs) await chmod(path.join(prebuilds, dir, 'spawn-helper'), 0o755);
  console.log(`Prepared executable PTY helpers: ${dirs.join(', ')}`);
}
