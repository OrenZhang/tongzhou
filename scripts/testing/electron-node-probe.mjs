// Read-only runtime experiment. Copies its synthetic project's dependencies;
// never rebuilds or changes the repository's installed native modules.
import electron from 'electron';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/electron-node-'));
const project = path.join(root, '项目 with spaces');
const modules = path.join(project, 'node_modules');
await mkdir(modules, { recursive: true });
for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path'])
  await cp(path.dirname(require.resolve(name + '/package.json')), path.join(modules, name), {
    recursive: true,
  });
const script = path.join(project, 'check.cjs');
await writeFile(
  script,
  `const Database=require('better-sqlite3');
const db=new Database(':memory:');
console.log(JSON.stringify({node:process.versions.node,modules:process.versions.modules,value:db.prepare('select 42 as value').get().value}));db.close();`,
);
const node = path.join(
  path.dirname(require.resolve('node/package.json')),
  'bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const inspect = (executable) =>
  JSON.parse(
    execFileSync(
      executable,
      [
        '-p',
        'JSON.stringify({node:process.versions.node,modules:process.versions.modules,electron:process.versions.electron})',
      ],
      { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000 },
    ),
  );
const run = (executable) => {
  try {
    return {
      exitCode: 0,
      stdout: execFileSync(executable, [script], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    };
  } catch (error) {
    return {
      exitCode: error.status ?? -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
    };
  }
};
const original = { runtime: inspect(node), project: run(node) };
assert.equal(
  original.project.exitCode,
  0,
  'The original bundled Node must run the reference project',
);
assert.equal(JSON.parse(original.project.stdout).value, 42);
const shared = { runtime: inspect(electron), project: run(electron) };
const compatible = shared.project.exitCode === 0;
if (compatible) assert.equal(JSON.parse(shared.project.stdout).value, 42);
else assert.match(shared.project.stderr, /NODE_MODULE_VERSION|compiled against a different Node/);
const report = {
  original,
  shared,
  existingProjectCompatible: compatible,
  removeStandaloneNode: compatible ? 'requires remaining desktop checks' : false,
  note: 'This probes one existing native dependency, not all Node project compatibility. No app configuration or installed modules were changed.',
};
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      original: original.runtime,
      shared: shared.runtime,
      existingProjectCompatible: compatible,
      report: path.join(root, 'report.json'),
    },
    null,
    2,
  ),
);
if (!compatible)
  console.log(
    'Standalone Node removal is not compatible with the existing reference project. Keep the production runtime.',
  );
