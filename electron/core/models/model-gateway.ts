import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Message, Provider } from '../../../src/shared/types';
import { completeRequest, type CompletionInput, type Completion, type ToolSpec } from './providers';
import { redact } from '../../services/storage/validation';
import { isContextOverflow } from '../runtime/history';

export interface ModelConnection {
  provider: Provider;
  model: string;
  secret: string;
}
type WireTool = { name: string; type: 'function_call' | 'custom_tool_call'; namespace?: string };
type ThoughtState = Pick<Message, 'anthropicContent' | 'reasoningContent' | 'responseReasoning'> & {
  signature?: string;
  signatureModel?: string;
};

/** Protocol conversion only: no tool handlers, task loop, or history compaction.
 * Codex owns those responsibilities, including the decision to call a tool. */
export function decodeModelRequest(body: any, sessionId: string) {
  if (!body || !Array.isArray(body.input) || !Array.isArray(body.tools ?? []))
    throw new Error('Invalid Responses request');
  const instructions: string[] = typeof body.instructions === 'string' ? [body.instructions] : [];
  const messages: Message[] = [];
  const names = new Map<string, WireTool>();
  const reverse = new Map<string, string>();
  const tools: ToolSpec[] = [];
  function addTool(t: any, namespace?: string) {
    if (t.type === 'namespace') {
      for (const child of t.tools ?? []) addTool(child, t.name);
      return;
    }
    if (!['function', 'custom'].includes(t.type) || typeof t.name !== 'string')
      throw new Error('模型适配器不支持工具类型：' + String(t.type));
    const original = [namespace, t.name].filter(Boolean).join('.');
    const name =
      !namespace && /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)
        ? t.name
        : 'tz_' +
          createHash('sha256').update(original).digest('hex').slice(0, 12) +
          '_' +
          t.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
    if (names.has(name)) throw new Error('Duplicate model tool');
    names.set(name, {
      name: t.name,
      namespace,
      type: t.type === 'custom' ? 'custom_tool_call' : 'function_call',
    });
    reverse.set(original, name);
    tools.push({
      name,
      description:
        (t.description ?? '') + (t.format ? '\nInput format: ' + JSON.stringify(t.format) : ''),
      parameters:
        t.type === 'custom'
          ? {
              type: 'object',
              properties: {
                input: {
                  type: 'string',
                  description: 'Tool input, using the tool description and format.',
                },
              },
              required: ['input'],
              additionalProperties: false,
            }
          : (t.parameters ?? { type: 'object', properties: {} }),
    });
  }
  for (const t of body.tools ?? []) addTool(t);
  const calls = new Map<string, string>();
  const runId = randomUUID();
  const message = (role: Message['role'], content = ''): Message => ({
    id: randomUUID(),
    sessionId,
    runId,
    createdAt: Date.now(),
    role,
    content,
    status: 'complete',
  });
  const textAndImages = (content: any) => {
    const parts =
      typeof content === 'string'
        ? [{ type: 'input_text', text: content }]
        : Array.isArray(content)
          ? content
          : [];
    let text = '';
    const images: NonNullable<Message['images']> = [];
    for (const p of parts) {
      if (['input_text', 'output_text', 'text'].includes(p.type)) text += String(p.text ?? '');
      else if (['input_image', 'image'].includes(p.type)) {
        const url = p.image_url ?? p.url;
        const match =
          typeof url === 'string'
            ? /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url)
            : null;
        if (!match || !['image/png', 'image/jpeg', 'image/webp'].includes(match[1]))
          throw new Error('模型适配器仅接受 PNG/JPEG/WebP 内联图片，不能静默忽略图片');
        images.push({
          mimeType: match[1] as 'image/png' | 'image/jpeg' | 'image/webp',
          data: match[2],
        });
      } else throw new Error('模型适配器不支持输入类型：' + String(p.type));
    }
    return { content: text, ...(images.length ? { images } : {}) };
  };
  for (const item of body.input) {
    if (item.type === 'message' || (!item.type && item.role)) {
      const content = textAndImages(item.content);
      if (item.role === 'developer' || item.role === 'system') {
        instructions.push(content.content);
        continue;
      }
      if (!['user', 'assistant'].includes(item.role)) throw new Error('Unsupported message role');
      messages.push({ ...message(item.role), ...content });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const original = [item.namespace, item.name].filter(Boolean).join('.');
      const name = reverse.get(original) ?? item.name;
      const args =
        item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments;
      calls.set(item.call_id, name);
      const previous = messages.at(-1);
      if (previous?.role === 'assistant')
        (previous.toolCalls ??= []).push({ id: item.call_id, name, arguments: args });
      else
        messages.push({
          ...message('assistant'),
          toolCalls: [{ id: item.call_id, name, arguments: args }],
        });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({
        ...message('tool'),
        ...textAndImages(item.output),
        toolCallId: item.call_id,
        toolName: calls.get(item.call_id) ?? 'historical_tool',
      });
    } else if (item.type === 'reasoning') {
      // Provider-private signatures are kept separately by the gateway, never translated into user instructions.
      continue;
    } else throw new Error('模型适配器不支持 Responses 项目：' + String(item.type));
  }
  return { instructions: instructions.join('\n\n'), messages, tools, names };
}

export async function modelGateway(options: {
  sessionId: string;
  resolve: () => Promise<ModelConnection>;
  complete?: (input: CompletionInput) => Promise<Completion>;
  loadState?: (callId: string) => ThoughtState | undefined;
  saveState?: (callId: string, state: ThoughtState) => void;
  transport?: typeof fetch;
}) {
  const token = randomBytes(32).toString('hex');
  const active = new Set<AbortController>();
  // Native thought signatures belong to their originating provider. Keep them
  // beside the response ID/call ID rather than trying to make Codex interpret them.
  const thoughtState = new Map<string, ThoughtState>();
  const server = createServer(async (req, res) => {
    const incoming = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from('Bearer ' + token);
    if (
      incoming.length !== expected.length ||
      !timingSafeEqual(incoming, expected) ||
      req.headers.origin ||
      req.method !== 'POST' ||
      req.url !== '/v1/responses'
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => controller.abort());
    let secret = '';
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 32_000_000) throw new Error('模型请求超过 32 MB');
      }
      const body = JSON.parse(raw);
      const decoded = decodeModelRequest(body, options.sessionId);
      const connection = await options.resolve();
      secret = connection.secret;
      for (const m of decoded.messages) {
        const callId = m.toolCalls?.[0]?.id;
        const state = callId
          ? (thoughtState.get(callId) ?? options.loadState?.(callId))
          : undefined;
        if (state)
          Object.assign(m, {
            anthropicContent: state.anthropicContent,
            reasoningContent: state.reasoningContent,
            responseReasoning: state.responseReasoning,
            providerId: connection.provider.id,
            model: connection.model,
          });
        for (const call of m.toolCalls ?? []) {
          const saved = thoughtState.get(call.id) ?? options.loadState?.(call.id);
          if (saved?.signature)
            Object.assign(call, {
              signature: saved.signature,
              signatureModel: saved.signatureModel,
            });
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      let sequence = 0;
      const send = (event: any) => {
        if (!res.destroyed)
          res.write('data: ' + JSON.stringify({ ...event, sequence_number: sequence++ }) + '\n\n');
      };
      const id = 'resp_' + randomUUID();
      send({
        type: 'response.created',
        response: { id, object: 'response', status: 'in_progress', output: [] },
      });
      heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(': keepalive\n\n');
      }, 15000);
      const output: any[] = [];
      let current: { index: number; item: any } | undefined;
      let streamedText = '';
      const finishItem = () => {
        if (!current) return;
        const { index, item } = current;
        if (item.type === 'message') {
          const part = item.content[0];
          send({
            type: 'response.output_text.done',
            item_id: item.id,
            output_index: index,
            content_index: 0,
            text: part.text,
          });
          send({
            type: 'response.content_part.done',
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part,
          });
          item.status = 'completed';
        } else {
          send({
            type: 'response.reasoning_summary_text.done',
            item_id: item.id,
            output_index: index,
            summary_index: 0,
            text: item.summary[0].text,
          });
          send({
            type: 'response.reasoning_summary_part.done',
            item_id: item.id,
            output_index: index,
            summary_index: 0,
            part: item.summary[0],
          });
        }
        send({ type: 'response.output_item.done', output_index: index, item });
        current = undefined;
      };
      const streamText = (delta: string) => {
        if (!delta) return;
        if (current?.item.type !== 'message') {
          finishItem();
          const item = {
            id: 'msg_' + randomUUID(),
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [{ type: 'output_text', text: '', annotations: [] }],
          };
          current = { index: output.length, item };
          output.push(item);
          send({
            type: 'response.output_item.added',
            output_index: current.index,
            item: { ...item, content: [] },
          });
          send({
            type: 'response.content_part.added',
            item_id: item.id,
            output_index: current.index,
            content_index: 0,
            part: item.content[0],
          });
        }
        current.item.content[0].text += delta;
        streamedText += delta;
        send({
          type: 'response.output_text.delta',
          item_id: current.item.id,
          output_index: current.index,
          content_index: 0,
          delta,
        });
      };
      const result = await (options.complete ?? completeRequest)({
        ...connection,
        transport: options.transport,
        instructions: decoded.instructions,
        messages: decoded.messages,
        historyPrepared: true,
        tools: decoded.tools,
        signal: controller.signal,
        onReasoning: (delta) => {
          if (!delta) return;
          if (current?.item.type !== 'reasoning') {
            finishItem();
            const item = {
              id: 'rs_' + randomUUID(),
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: '' }],
            };
            current = { index: output.length, item };
            output.push(item);
            send({
              type: 'response.output_item.added',
              output_index: current.index,
              item: { ...item, summary: [] },
            });
            send({
              type: 'response.reasoning_summary_part.added',
              item_id: item.id,
              output_index: current.index,
              summary_index: 0,
              part: item.summary[0],
            });
          }
          current.item.summary[0].text += delta;
          send({
            type: 'response.reasoning_summary_text.delta',
            item_id: current.item.id,
            output_index: current.index,
            summary_index: 0,
            delta,
          });
        },
        onDelta: streamText,
      });
      controller.signal.throwIfAborted();
      if (result.text !== streamedText) {
        if (!result.text.startsWith(streamedText)) throw new Error('模型最终正文与流式正文不一致');
        streamText(result.text.slice(streamedText.length));
      }
      finishItem();
      for (const call of result.toolCalls) {
        const spec = decoded.names.get(call.name);
        if (!spec) throw new Error('模型返回未声明的工具：' + call.name);
        const item = {
          id: 'fc_' + randomUUID(),
          call_id: call.id,
          type: spec.type,
          name: spec.name,
          ...(spec.namespace ? { namespace: spec.namespace } : {}),
          status: 'completed',
          ...(spec.type === 'custom_tool_call'
            ? { input: JSON.parse(call.arguments).input }
            : { arguments: call.arguments }),
        };
        // Buffer tool arguments until the provider confirms a complete response.
        // Truncated generation must never execute a partially generated write.
        send({ type: 'response.output_item.added', output_index: output.length, item });
        send({ type: 'response.output_item.done', output_index: output.length, item });
        output.push(item);
        thoughtState.set(call.id, {
          signature: call.signature,
          signatureModel: call.signatureModel,
          anthropicContent: result.anthropicContent,
          reasoningContent: result.reasoningContent,
          responseReasoning: result.responseReasoning,
        });
        options.saveState?.(call.id, thoughtState.get(call.id)!);
      }
      while (thoughtState.size > 500) thoughtState.delete(thoughtState.keys().next().value!);
      send({
        type: 'response.completed',
        response: {
          id,
          object: 'response',
          status: 'completed',
          output,
          ...(result.usageReported || result.inputTokens || result.outputTokens
            ? {
                usage: {
                  input_tokens: result.inputTokens,
                  output_tokens: result.outputTokens,
                  total_tokens: result.inputTokens + result.outputTokens,
                },
              }
            : {}),
        },
      });
      res.end();
    } catch (error) {
      if (!res.destroyed) {
        const message = redact(error instanceof Error ? error.message : String(error), [secret]);
        const detail = {
          message,
          ...(isContextOverflow(error) ? { code: 'context_length_exceeded' } : {}),
        };
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: detail }));
        } else
          res.end(
            'data: ' +
              JSON.stringify({
                type: 'response.failed',
                response: { status: 'failed', error: detail },
              }) +
              '\n\n',
          );
      }
    } finally {
      clearInterval(heartbeat);
      active.delete(controller);
    }
  });
  server.requestTimeout = 31 * 60 * 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    token,
    close() {
      for (const c of active) c.abort();
      server.closeAllConnections();
      server.close();
      thoughtState.clear();
    },
  };
}
