import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
if (process.platform !== 'darwin')
  throw new Error('This physical assertion probe currently validates macOS only');
const fixture = path.resolve(process.argv[2] ?? '');
const proof = JSON.parse(await readFile(path.join(fixture, 'report.json'), 'utf8'));
assert.equal(proof.mcpFetches, 1, 'use the disposable test:tauri fixture, never a user profile');
assert.match(proof.authorization, /no user login/);
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/tauri-native-'));
const profile = path.join(root, 'profile');
await mkdir(profile);
await cp(path.join(fixture, 'profile/tongzhou.db'), path.join(profile, 'tongzhou.db'));
const database = new DatabaseSync(path.join(profile, 'tongzhou.db'));
database.prepare('DELETE FROM secrets').run();
for (const row of database.prepare("SELECT id,value FROM objects WHERE kind='provider'").all()) {
  database
    .prepare("UPDATE objects SET value=? WHERE kind='provider' AND id=?")
    .run(JSON.stringify({ ...JSON.parse(row.value), enabled: false }), row.id);
}
database
  .prepare('INSERT OR REPLACE INTO objects(kind,id,value) VALUES(?,?,?)')
  .run(
    'preferences',
    'power',
    JSON.stringify({ id: 'power', keepAwakeOnAC: true, keepAwakeWhenLidClosed: false }),
  );
database.close();
const log = openSync(path.join(root, 'native.log'), 'a');
const child = spawn(
  path.resolve('src-tauri/target/release/bundle/macos/CoSail.app/Contents/MacOS/cosail-preview'),
  [],
  {
    stdio: ['ignore', log, log],
    env: { ...process.env, TONGZHOU_TAURI_DATA_DIR: profile, TONGZHOU_DISABLE_UPDATES: '1' },
  },
);
closeSync(log);
let result;
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    result = { code, signal };
    resolve(result);
  });
});
const assertions = async () => (await exec('/usr/bin/pmset', ['-g', 'assertions'])).stdout;
try {
  const deadline = Date.now() + 25000;
  let active = false;
  while (Date.now() < deadline && !result) {
    active = (await assertions())
      .split('\n')
      .some(
        (line) =>
          line.includes(`pid ${child.pid}(`) && line.includes('CoSail AC-only background tasks'),
      );
    if (active) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(active, 'close other Preview instances and connect AC power before this probe');
  child.kill('SIGTERM');
  child.kill('SIGINT');
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Native graceful shutdown timed out')), 18000).unref(),
    ),
  ]);
  assert.deepEqual(
    result,
    { code: 0, signal: null },
    'SIGTERM must use Tauri graceful shutdown, not kill the process',
  );
  assert.ok(
    !(await assertions())
      .split('\n')
      .some(
        (line) =>
          line.includes(`pid ${child.pid}(`) && line.includes('CoSail AC-only background tasks'),
      ),
  );
  const { stdout } = await exec('/bin/ps', ['-axo', 'command']);
  assert.ok(
    !stdout.split('\n').some((line) => line.includes('tauri-host.cjs') && line.includes(profile)),
    'Node core must exit with the native host',
  );
  await writeFile(
    path.join(root, 'report.json'),
    JSON.stringify(
      {
        platform: 'macOS',
        nativeTrayStartup: true,
        acAssertionCreated: true,
        gracefulSignalExit: true,
        repeatedExitRequests: true,
        assertionReleased: true,
        nodeCoreExited: true,
        lidPolicyChanged: false,
        installerExecuted: false,
      },
      null,
      2,
    ),
  );
  console.log('Tauri native lifecycle passed:', root);
} finally {
  if (!result) {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15000))]);
    if (!result) child.kill('SIGKILL');
  }
}
