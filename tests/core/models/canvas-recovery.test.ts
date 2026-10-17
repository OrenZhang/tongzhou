import { describe, expect, it } from 'vitest';
import {
  completeCanvasRequest,
  type CompletionInput,
} from '../../../electron/core/models/providers';
import { modelGateway } from '../../../electron/core/models/model-gateway';

function reply(args: string, finish = 'tool_calls', name = 'canvas_apply') {
  return new Response(
    'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: {
              content: '正在配置。',
              tool_calls: [{ index: 0, id: 'apply', function: { name, arguments: args } }],
            },
            finish_reason: finish,
          },
        ],
      }) +
      '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
function fixture(responses: (() => Response)[]) {
  const requests: any[] = [],
    chunks: string[] = [];
  const controller = new AbortController();
  const input: CompletionInput = {
    provider: {
      id: 'test',
      name: 'test',
      protocol: 'openai-chat',
      auth: 'none',
      baseUrl: 'https://unused.invalid',
      models: ['test'],
      maxOutputTokens: 1000,
      contextChars: 0,
    },
    secret: '',
    model: 'test',
    instructions: '配置画布',
    messages: [],
    tools: [{ name: 'canvas_apply', description: 'edit', parameters: { type: 'object' } }],
    signal: controller.signal,
    onDelta: (v) => chunks.push(v),
    transport: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (init?.signal?.aborted) throw init.signal.reason;
      return responses[Math.min(requests.length - 1, responses.length - 1)]();
    }) as typeof fetch,
  };
  return { input, requests, chunks, controller };
}
describe('canvas model argument recovery', () => {
  it('recovers Anthropic-format argument fragments used by subscription connections', async () => {
    const response = (json: string) =>
      new Response(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'apply', name: 'canvas_apply', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: json },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_stop' },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    const f = fixture([() => response('{"ops":['), () => response('{"ops":[]}')]);
    f.input.provider.protocol = 'anthropic';
    const result = await completeCanvasRequest(f.input);
    expect(f.requests).toHaveLength(2);
    expect(result.toolCalls[0].arguments).toBe('{"ops":[]}');
    expect(result.anthropicContent?.[0]).toMatchObject({ type: 'tool_use', input: { ops: [] } });
  });
  it('regenerates once after a completed malformed edit and preserves streamed text', async () => {
    const f = fixture([() => reply('{"ops":['), () => reply('{"ops":[]}')]);
    const result = await completeCanvasRequest(f.input);
    expect(f.requests).toHaveLength(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0].arguments)).toEqual({ ops: [] });
    expect(result.text).toBe(f.chunks.join(''));
    expect(f.requests[1].messages[0].content).toContain('整批调用均未执行');
  });
  it('stops after one unsuccessful regeneration', async () => {
    const f = fixture([() => reply('{"ops":[')]);
    await expect(completeCanvasRequest(f.input)).rejects.toThrow('参数不完整');
    expect(f.requests).toHaveLength(2);
  });
  it.each(['length', 'other-tool', 'disconnect'])('does not retry %s', async (reason) => {
    const f = fixture([
      () =>
        reason === 'disconnect'
          ? new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
              headers: { 'Content-Type': 'text/event-stream' },
            })
          : reply(
              '{"ops":[',
              reason === 'length' ? 'length' : 'tool_calls',
              reason === 'other-tool' ? 'write_file' : 'canvas_apply',
            ),
    ]);
    await expect(completeCanvasRequest(f.input)).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });
  it('respects cancellation before recovery', async () => {
    const f = fixture([() => reply('{"ops":[')]);
    f.input.onDelta = () => f.controller.abort(new Error('cancelled'));
    await expect(completeCanvasRequest(f.input)).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });
  it('releases only the repaired tool call through the real gateway', async () => {
    const f = fixture([() => reply('{"ops":['), () => reply('{"ops":[]}')]);
    const gateway = await modelGateway({
      sessionId: 'test',
      resolve: async () => ({ provider: f.input.provider, model: 'test', secret: '' }),
      transport: f.input.transport,
    });
    try {
      const response = await fetch(gateway.baseUrl + '/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + gateway.token },
        body: JSON.stringify({
          input: [],
          tools: [{ type: 'function', name: 'canvas_apply', parameters: { type: 'object' } }],
        }),
      });
      const events = (await response.text())
        .split('\n')
        .filter((v) => v.startsWith('data: '))
        .map((v) => JSON.parse(v.slice(6)));
      const calls = events.filter(
        (e) => e.type === 'response.output_item.done' && e.item.type === 'function_call',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].item.arguments).toBe('{"ops":[]}');
      expect(events.at(-1).type).toBe('response.completed');
      expect(f.requests).toHaveLength(2);
    } finally {
      gateway.close();
    }
  });
});
