import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
const server = new Server(
  { name: 'tongzhou-tools', version: '0.5.1' },
  { capabilities: { tools: {} } },
);
async function request(body: unknown, signal?: AbortSignal) {
  const url = new URL(process.env.TONGZHOU_TOOL_URL!);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error('Invalid local bridge');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.TONGZHOU_TOOL_TOKEN,
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(31 * 60 * 1000)])
      : AbortSignal.timeout(31 * 60 * 1000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('同舟工具通道已关闭或请求失败');
  return response.json();
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: await request({ method: 'list' }),
}));
server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
  request(
    {
      method: 'call',
      name: req.params.name,
      arguments: req.params.arguments ?? {},
      callId: randomUUID(),
    },
    extra.signal,
  ),
);
server.connect(new StdioServerTransport()).catch(() => process.exit(1));
