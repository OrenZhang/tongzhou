import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/request-identity-'));
const bundle = path.join(root, 'network.cjs');
await build({
  entryPoints: ['electron/service-network.ts'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
const main = path.join(root, 'main.cjs');
await writeFile(main, `const { app } = require('electron'); app.whenReady();`);
const received = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  received.push({
    ua: req.headers['user-agent'],
    auth: req.headers.authorization,
    cookie: req.headers.cookie,
    body,
  });
  res.end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: [main, `--user-data-dir=${path.join(root, 'profile')}`],
    env,
  });
  const result = await app.evaluate(
    async ({ app, session }, { bundle, url }) => {
      await app.whenReady();
      const require = process.getBuiltinModule('module').createRequire(bundle);
      const { setServiceTransport, serviceFetch } = require(bundle);
      const isolated = session.fromPartition('tongzhou-identity-fixture');
      await isolated.cookies.set({ url, name: 'fixture', value: 'must-not-leak' });
      setServiceTransport((input, init) =>
        isolated.fetch(input instanceof URL ? input.href : input, {
          ...init,
          bypassCustomProtocolHandlers: true,
        }),
      );
      return (
        await serviceFetch(url, {
          method: 'POST',
          body: 'fixture-body',
          credentials: 'include',
          redirect: 'error',
          headers: { 'User-Agent': 'OpenAI/JS fixture', Authorization: 'Bearer fixture' },
        })
      ).text();
    },
    { bundle, url: `http://127.0.0.1:${server.address().port}/` },
  );
  assert.equal(result, 'ok');
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.deepEqual(received, [
    { ua: `Tongzhou/${version}`, auth: 'Bearer fixture', cookie: undefined, body: 'fixture-body' },
  ]);
  console.log(
    'PASS: Electron session sends Tongzhou identity, preserves auth/body and omits cookies.',
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
}
