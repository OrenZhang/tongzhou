import { appFetch, clientIdentity } from './request-identity';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
const server = new Server(
  { name: 'tongzhou-tools', version: clientIdentity.version },
  { capabilities: { tools: {} } },
);
async function request(body: unknown, signal?: AbortSignal) {
  const url = new URL(process.env.TONGZHOU_TOOL_URL!);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error('Invalid local bridge');
  const response = await appFetch(url, {
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
  if (!response.ok)
    throw new Error(
      response.status === 413
        ? '工具参数超过单次请求大小限制，请分批提交文件或编辑'
        : response.status === 403
          ? '同舟工具通道认证失败，请重新开始本轮任务'
          : `同舟工具请求失败（HTTP ${response.status}），请检查参数后重试`,
    );
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
