import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ToolScope } from './extensions';

/** Private per-run channel for the stdio MCP adapter; never accepts a new tool catalog. */
export async function toolBridge(scope: ToolScope, signal: AbortSignal) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const provided = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from('Bearer ' + token);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected) ||
      req.headers.origin ||
      req.method !== 'POST' ||
      req.url !== '/tools'
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      signal.throwIfAborted();
      let raw = '';
      for await (const b of req) {
        raw += b;
        if (raw.length > 100000) {
          res.writeHead(413);
          res.end();
          return;
        }
      }
      const input = JSON.parse(raw);
      let result: unknown;
      if (input.method === 'list')
        result = scope.specs.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        }));
      else if (input.method === 'call') {
        const output = await scope.call(input.name, input.arguments, input.callId);
        result = {
          isError: output.isError,
          content: [
            { type: 'text', text: output.text },
            ...(output.images ?? []).map((i) => ({ type: 'image', ...i })),
          ],
        };
      } else throw new Error('Unknown method');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) {
    close();
    signal.throwIfAborted();
  }
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const root = path
    .dirname(require.resolve('node/package.json', { paths: [__dirname, process.cwd()] }))
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  return {
    config: {
      name: 'tongzhou-tools',
      command: path.join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      args: [
        path
          .join(__dirname, 'tool-proxy.cjs')
          .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
      ],
      env: [
        {
          name: 'TONGZHOU_TOOL_URL',
          value: `http://127.0.0.1:${(server.address() as AddressInfo).port}/tools`,
        },
        { name: 'TONGZHOU_TOOL_TOKEN', value: token },
      ],
    },
    close() {
      signal.removeEventListener('abort', close);
      close();
    },
  };
}
