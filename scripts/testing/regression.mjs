// Run after npm run build. Each suite owns an isolated profile and test fixtures.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const suites = [
  'model-capabilities',
  'canvas',
  'canvas-chat',
  'comfyui',
  'canvas-import',
  'canvas-media-node',
  'canvas-node-config',
  'canvas-routing',
  'canvas-text-source',
  'whiteboard',
  'studio-library',
  'module-navigation',
  'notification-ui',
  'smoke',
  'session-entry',
  'state-boundaries',
  'project-context',
  'project-deletion',
  'workbench',
  'workspace-layout',
  'inline-approval',
  'terminal-entry',
  'turn-process',
  'extensions',
  'client-management',
  'capabilities',
  'knowledge',
  'knowledge-ontology',
  'knowledge-density',
  'knowledge-scroll',
  'personalization',
  'content-workspace',
  'automation',
  'attachments',
  'artifacts',
  'markdown',
  'appearance',
  'ui',
  'workflows',
  'task-workbench',
  'account-ui',
  'account-proxy',
  'managed-network',
  'native',
  'updates',
  'dynamic-tools',
  'codex-platform',
  'codex-interactions',
  'request-identity',
  'node-identity',
  'codex-identity',
  'kimi-identity',
  'package',
];
const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');
if (only?.some((name) => !suites.includes(name))) throw new Error('Unknown suite in --only');
const selected = only ?? suites;
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/regression-'));
const results = [];
let index = 0;
async function worker() {
  while (index < selected.length) {
    const name = selected[index++],
      startedAt = Date.now();
    const logFile = path.join(root, name + '.log'),
      log = createWriteStream(logFile);
    const script = name === 'smoke' ? 'smoke.mjs' : name + '-smoke.mjs';
    console.log('START ' + name);
    const child = spawn(process.execPath, ['scripts/testing/' + script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, TONGZHOU_DISABLE_UPDATES: '1' },
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      if (process.platform === 'win32')
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill();
        }
      }
    }, 180000);
    const exitCode = await new Promise((resolve) => {
      child.once('exit', resolve);
      child.once('error', (e) => {
        log.write(String(e));
        resolve(-1);
      });
    });
    clearTimeout(timer);
    await new Promise((resolve) => log.end(resolve));
    results.push({ name, exitCode, timedOut, durationMs: Date.now() - startedAt, logFile });
    await writeFile(
      path.join(root, 'report.json'),
      JSON.stringify(
        { results, liveServices: 'Not tested; requires existing valid account authorization.' },
        null,
        2,
      ),
    );
    console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${name}`);
    if (exitCode !== 0) console.error((await readFile(logFile, 'utf8')).slice(-16000));
  }
}
// Desktop suites share the system clipboard and focus; run them sequentially.
await worker();
console.log(`Results: ${path.join(root, 'report.json')}`);
process.exitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;
