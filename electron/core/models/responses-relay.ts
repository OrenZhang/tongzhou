import type { ServerResponse } from 'node:http';
import type { ModelConnection } from './model-gateway';
import { headers, sse } from './providers';
import { appFetch } from '../../services/network/request-identity';
import { thinkingRequest } from '../runtime/thinking';
import { IdleTimeout } from '../runtime/idle-timeout';

/** Keep Codex's native roles, tool grammar, staged tools and opaque reasoning intact.
 * Only connection-owned settings are replaced; execution stays in Codex. */
export async function relayResponses(
  body: any,
  connection: ModelConnection,
  res: ServerResponse,
  signal: AbortSignal,
  transport: typeof fetch = appFetch,
) {
  if (!body || !Array.isArray(body.input) || !Array.isArray(body.tools ?? []))
    throw new Error('Invalid Responses request');
  const { provider, model, secret } = connection;
  const thinking = thinkingRequest(provider, model).body;
  const request = {
    ...body,
    model,
    stream: true,
    store: false,
    max_output_tokens: provider.maxOutputTokens,
    ...(thinking.reasoning ? { reasoning: { ...body.reasoning, ...thinking.reasoning } } : {}),
    ...(thinking.include
      ? { include: [...new Set([...(body.include ?? []), ...thinking.include])] }
      : {}),
  };
  const idleAbort = new AbortController();
  const idle = new IdleTimeout(300000, () =>
    idleAbort.abort(new Error('模型连接连续 5 分钟没有响应；已收到内容保留。')),
  );
  try {
    const response = await transport(provider.baseUrl.replace(/\/$/, '') + '/responses', {
      method: 'POST',
      headers: headers(provider, secret),
      body: JSON.stringify(request),
      signal: AbortSignal.any([signal, idleAbort.signal]),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`模型服务返回 ${response.status}: ${(await response.text()).slice(0, 1600)}`);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
      throw new Error('服务未返回 SSE 流，请检查协议与服务地址。');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    let pending: string[] | undefined;
    let pendingBytes = 0;
    for await (const event of sse(response.body, () => idle.touch())) {
      signal.throwIfAborted();
      if (event.data === '[DONE]') continue;
      const data = JSON.parse(event.data);
      const type = data.type ?? event.event;
      if (type === 'error' || type === 'response.failed')
        throw new Error(data.error?.message ?? data.response?.error?.message ?? '模型服务响应失败');
      if (type === 'response.incomplete')
        throw new Error(
          data.response?.incomplete_details?.reason === 'max_output_tokens'
            ? `模型输出达到上限（${provider.maxOutputTokens} Tokens），已收到正文保留；未完成的工具调用不会执行。`
            : '模型响应未完成，已收到正文保留；未完成的工具调用不会执行。',
        );
      // Tool completion can trigger writes. Hold the remaining ordered events
      // until the upstream confirms success, just as the conversion path does.
      if (
        ['response.output_item.added', 'response.output_item.done'].includes(type) &&
        /_call$/.test(data.item?.type ?? '')
      )
        pending ??= [];
      const wire = (event.event ? `event: ${event.event}\n` : '') + `data: ${event.data}\n\n`;
      if (pending) {
        pendingBytes += Buffer.byteLength(wire);
        if (pendingBytes > 32_000_000) throw new Error('模型工具响应超过 32 MB');
        pending.push(wire);
      }
      if (type === 'response.completed') {
        if (data.response?.status !== 'completed') throw new Error('模型未确认响应完成');
        if (
          data.response.output?.some(
            (item: any) =>
              /_call$/.test(item.type ?? '') && item.status && item.status !== 'completed',
          )
        )
          throw new Error('模型工具调用未完成，未执行该操作。');
        if (pending) for (const part of pending) res.write(part);
        else res.write(wire);
        res.end();
        return;
      }
      if (!pending) res.write(wire);
    }
    throw new Error('模型流在完成前断开，已收到正文保留；未完成的工具调用不会执行。');
  } finally {
    idle.dispose();
  }
}
