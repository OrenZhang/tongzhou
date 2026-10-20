import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { nodeNetwork } from '../../electron/hosts/node-network';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as { port: number }).port;
}
it('keeps OAuth loopback direct and preserves Request method, body and identity headers', async () => {
  let connects = 0;
  const proxy = createServer();
  proxy.on('connect', (_request, socket) => {
    connects++;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  const proxyPort = await listen(proxy);
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({ method: request.method, body, agent: request.headers['user-agent'] }),
    );
  });
  const port = await listen(server);
  const network = nodeNetwork();
  cleanup.push(() => network.dispose());
  const transport = await network.transport({
    mode: 'proxy',
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
  });
  const response = await transport(
    new Request(`http://127.0.0.1:${port}/callback`, { method: 'POST', body: 'loopback-proof' }),
  );
  const result = await response.json();
  expect(result).toMatchObject({ method: 'POST', body: 'loopback-proof' });
  expect(result.agent).toMatch(/^CoSail\//);
  expect(connects).toBe(0);
  await expect(
    transport('https://proxy-fixture.invalid/', { signal: AbortSignal.timeout(3000) }),
  ).rejects.toThrow();
  expect(connects).toBeGreaterThan(0);
});
it('requires managed profiles to be resolved rather than silently ignoring the selected network', async () => {
  const network = nodeNetwork();
  cleanup.push(() => network.dispose());
  await expect(network.transport({ mode: 'managed', profileId: 'fixture' })).rejects.toThrow(
    '解析托管网络',
  );
});
