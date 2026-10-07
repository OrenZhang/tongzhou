import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/node-identity-'));
const bootstrap = path.join(root, 'node-request-identity.cjs');
await build({
  entryPoints: ['electron/services/network/node-request-identity.ts'],
  outfile: bootstrap,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const received = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  received.push({
    url: req.url,
    ua: req.headers['user-agent'],
    auth: req.headers.authorization,
    body,
  });
  res.end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const fixture = path.join(root, 'fixture.mjs');
await writeFile(path.join(root, 'fork.mjs'), `await (await fetch(process.argv[2])).text();`);
await writeFile(
  fixture,
  `
import http, { request, get } from 'node:http';
import { spawnSync, fork } from 'node:child_process';
const base = process.argv[2];
await (await fetch(base+'/fetch', {method:'POST',body:'kept',headers:{'User-Agent':'OpenAI/JS 6.34.0',Authorization:'Bearer fixture'}})).text();
await (await fetch(new Request(base+'/request', {headers:{'user-agent':'old'}}))).text();
await (await fetch(base+'/subscription', {headers:{'User-Agent':process.argv[3]+' clash.meta'}})).text();
await new Promise((resolve,reject)=>{const r=request(base+'/node', {headers:{'USER-AGENT':'sdk',Authorization:'Bearer fixture'}},res=>{res.resume();res.on('end',resolve)});r.on('error',reject);r.end('node-body');});
await new Promise((resolve,reject)=>get(base+'/get',res=>{res.resume();res.on('end',resolve)}).on('error',reject));
const child=spawnSync(process.execPath,['-e',"fetch(process.argv[1]).then(r=>r.text())",base+'/child'],{encoding:'utf8'});
if(child.status!==0)throw Error(child.stderr);
await new Promise((resolve,reject)=>{const child=fork(new URL('./fork.mjs',import.meta.url),[base+'/fork'],{stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('fork failed')))});
`,
);
try {
  const require = createRequire(import.meta.url);
  const node = path.join(
    path.dirname(require.resolve('node/package.json')),
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const ua = `Tongzhou/${version}`;
  await new Promise((resolve, reject) => {
    const child = spawn(node, ['--require', bootstrap, fixture, url, ua], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (data) => (error += data));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(Error(error))));
  });
  assert.equal(received.length, 7);
  for (const r of received.filter((r) => !['/subscription', '/child', '/fork'].includes(r.url)))
    assert.equal(r.ua, ua);
  assert.equal(received.find((r) => r.url === '/subscription').ua, ua + ' clash.meta');
  assert.equal(received.find((r) => r.url === '/fetch').auth, 'Bearer fixture');
  assert.equal(received.find((r) => r.url === '/fetch').body, 'kept');
  assert.equal(received.find((r) => r.url === '/node').auth, 'Bearer fixture');
  assert.notEqual(
    received.find((r) => r.url === '/child').ua,
    ua,
    'Project child processes must not inherit app network hooks',
  );
  assert.notEqual(
    received.find((r) => r.url === '/fork').ua,
    ua,
    'fork must not inherit the app preload',
  );
  console.log(
    'PASS: managed Node fetch/Request/http.request/http.get use one identity; project subprocesses remain independent.',
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
