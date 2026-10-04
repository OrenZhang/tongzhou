import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  complete,
  headers,
  portableHistory,
  requestBody,
  sse,
  type CompletionInput,
} from '../electron/providers';
import type { Message, Protocol } from '../src/shared/types';
const message: Message = { id: 'm', sessionId: 's', role: 'user', content: '你好', createdAt: 1 };
function input(protocol: Protocol, baseUrl = 'http://127.0.0.1:1234/v1'): CompletionInput {
  return {
    provider: {
      id: 'p',
      name: 'p',
      protocol,
      baseUrl,
      auth: 'none',
      models: ['test'],
      maxOutputTokens: 1024,
      contextChars: 10000,
    },
    secret: '',
    model: 'test',
    instructions: 'test',
    messages: [message],
    tools: [],
    signal: new AbortController().signal,
    onDelta: () => {},
  };
}
async function serve(events: string[], fn: (base: string, requests: any[]) => Promise<void>) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const b of req) body += b;
    requests.push({ path: req.url, body: JSON.parse(body), headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) {
      const bytes = Buffer.from(event);
      for (let i = 0; i < bytes.length; i += 3) res.write(bytes.subarray(i, i + 3));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const event = (d: any) => 'data: ' + JSON.stringify(d) + '\n\n';
describe('streaming protocol adapters', () => {
  it('does not replay output or retry unrelated errors during compaction', async () => {
    for (const partial of [false, true]) {
      await serve(
        [
          ...(partial ? [event({ choices: [{ delta: { content: 'already started' } }] })] : []),
          event({
            error: { message: partial ? 'Maximum context length exceeded' : 'Rate limit exceeded' },
          }),
        ],
        async (base, requests) => {
          const request = input('openai-chat', base);
          let retries = 0;
          request.onContextRetry = (_target, messages) => {
            retries++;
            return messages;
          };
          await expect(complete(request)).rejects.toThrow(
            partial ? 'Maximum context' : 'Rate limit',
          );
          expect(retries).toBe(0);
          expect(requests).toHaveLength(1);
        },
      );
    }
  });
  it('automatically compacts a rejected context and retries without losing the current request', async () => {
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      if (requests.length === 1) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: { code: 'context_length_exceeded', message: 'Maximum context length exceeded' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        event({ choices: [{ delta: { content: 'continued' }, finish_reason: 'stop' }] }) +
          'data: [DONE]\n\n',
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const request = input(
        'openai-chat',
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      );
      request.historyPrepared = true;
      request.messages = [
        message,
        { ...message, id: 'old', role: 'assistant', content: 'old code '.repeat(30000) },
        { ...message, id: 'latest', content: '继续实现，保留订单数据' },
      ];
      let compacted = 0;
      request.onContextRetry = (target, messages) => {
        compacted++;
        return portableHistory(messages, target);
      };
      expect((await complete(request)).text).toBe('continued');
      expect(compacted).toBe(1);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]).length).toBeLessThan(
        JSON.stringify(requests[0]).length / 2,
      );
      expect(requests[1].messages.some((m: any) => m.content === '继续实现，保留订单数据')).toBe(
        true,
      );
      expect(request.messages[1].content).toHaveLength(270000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it('preserves interrupted replies and failed tool evidence during a provider switch', () => {
    const params = input('anthropic');
    params.messages = [
      message,
      {
        ...message,
        id: 'partial',
        role: 'assistant',
        status: 'interrupted',
        content: 'Already wrote first file',
        providerId: 'old',
        model: 'old-model',
        toolCalls: [{ id: 'old-call', name: 'write_file', arguments: '{}' }],
      },
      {
        ...message,
        id: 'result',
        role: 'tool',
        toolCallId: 'old-call',
        toolName: 'write_file',
        content: 'File saved before interruption',
        status: 'error',
      },
      { ...message, id: 'next', content: 'Continue without repeating' },
    ];
    const body = JSON.stringify(requestBody(params).body);
    expect(body).toContain('Already wrote first file');
    expect(body).toContain('File saved before interruption');
    expect(body).toContain('未完成');
    expect(body).not.toContain('"tool_use"');
    expect(body).not.toContain('"tool_result"');
  });
  it('converts orphan results to portable text, without manufacturing an executable call', () => {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
      const params = input(protocol);
      params.messages = [
        message,
        {
          ...message,
          id: 'orphan',
          role: 'tool',
          toolCallId: 'missing',
          toolName: 'click',
          content: 'done',
        },
      ];
      const body = JSON.stringify(requestBody(params).body);
      expect(body).toContain('历史工具结果');
      expect(body).not.toContain('"tool_call_id"');
      expect(body).not.toContain('"tool_result"');
      expect(body).not.toContain('"function_call_output"');
    }
  });
  it('sends only the current turn screenshot and never forwards stale images on handoff', () => {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
      const params = input(protocol);
      params.messages = [
        { ...message, runId: 'r' },
        {
          ...message,
          id: 'a',
          role: 'assistant',
          providerId: 'p',
          model: 'test',
          toolCalls: [{ id: 'c', name: 'computer_screenshot', arguments: '{}' }],
          runId: 'r',
        },
        {
          ...message,
          id: 't',
          role: 'tool',
          toolCallId: 'c',
          toolName: 'computer_screenshot',
          content: 'frame',
          runId: 'r',
          images: [{ mimeType: 'image/png', data: 'cGl4ZWxz' }],
        },
      ];
      expect(JSON.stringify(requestBody(params).body)).toContain('cGl4ZWxz');
      params.messages.push({ ...message, id: 'next', content: 'Switch', runId: 'next' });
      params.provider.id = 'other';
      const switched = JSON.stringify(requestBody(params).body);
      expect(switched).not.toContain('cGl4ZWxz');
      expect(switched).toContain('frame');
    }
  });
  it('preserves MiniMax/Anthropic thinking blocks across a tool round, but not a provider handoff', async () => {
    const blocks = [
      { type: 'thinking', thinking: 'fixture reasoning', signature: 'fixture-signature' },
      { type: 'text', text: 'Working' },
      { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'README.md' } },
    ];
    await serve(
      [
        event({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
        event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'fixture reasoning' },
        }),
        event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'fixture-signature' },
        }),
        event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        event({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Working' },
        }),
        event({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'call-1', name: 'read_file', input: {} },
        }),
        event({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' },
        }),
        event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
        event({ type: 'message_stop' }),
      ],
      async (base) => {
        const request = input('anthropic', base);
        const result = await complete(request);
        expect(result.anthropicContent).toEqual(blocks);
        const assistant: Message = {
          ...message,
          id: 'assistant',
          role: 'assistant',
          content: result.text,
          providerId: 'p',
          model: 'test',
          toolCalls: result.toolCalls,
          anthropicContent: result.anthropicContent,
        };
        request.messages = [
          message,
          assistant,
          { ...message, id: 'tool', role: 'tool', toolCallId: 'call-1', content: 'file contents' },
        ];
        expect((requestBody(request).body as any).messages[1].content).toEqual(blocks);
        const foreign = requestBody({ ...request, provider: { ...request.provider, id: 'other' } });
        expect(JSON.stringify(foreign)).not.toContain('fixture-signature');
        expect(JSON.stringify(foreign)).not.toContain('fixture reasoning');
      },
    );
  });
  it('handles UTF-8, CRLF and multiline SSE at arbitrary byte boundaries', async () => {
    const bytes = Buffer.from('event: test\r\ndata: {"text":\r\ndata: "同舟"}\r\n\r\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    const out = [];
    for await (const e of sse(stream)) out.push(e);
    expect(out).toEqual([{ event: 'test', data: '{"text":\n"同舟"}' }]);
  });
  it('assembles fragmented Chat Completions tool calls and usage', async () => {
    await serve(
      [
        event({
          choices: [
            {
              delta: {
                content: '同舟',
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } },
                ],
              },
            },
          ],
        }),
        event({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
        'data: [DONE]\n\n',
      ],
      async (base, reqs) => {
        const deltas: string[] = [];
        const result = await complete({
          ...input('openai-chat', base),
          onDelta: (t) => deltas.push(t),
        });
        expect(result).toMatchObject({
          text: '同舟',
          inputTokens: 12,
          outputTokens: 4,
          toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' }],
        });
        expect(deltas.join('')).toBe('同舟');
        expect(reqs[0].path).toBe('/v1/chat/completions');
        expect(reqs[0].headers.authorization).toBeUndefined();
      },
    );
  });
  it('parses Responses tool items, deltas and completion', async () => {
    await serve(
      [
        event({ type: 'response.output_text.delta', delta: 'Ready' }),
        event({
          type: 'response.output_item.added',
          item: {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'c',
            name: 'list_files',
            arguments: '',
          },
        }),
        event({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_1',
          delta: '{"path":""}',
        }),
        event({
          type: 'response.completed',
          response: { usage: { input_tokens: 10, output_tokens: 5 } },
        }),
      ],
      async (base, reqs) => {
        const result = await complete(input('openai-responses', base));
        expect(result.toolCalls[0].arguments).toBe('{"path":""}');
        expect(result.inputTokens).toBe(10);
        expect(reqs[0].body.store).toBe(false);
      },
    );
  });
  it('parses Anthropic content blocks and stop status', async () => {
    await serve(
      [
        event({ type: 'message_start', message: { usage: { input_tokens: 7 } } }),
        event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        }),
        event({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 't', name: 'list_files' },
        }),
        event({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":""}' },
        }),
        event({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 3 },
        }),
        event({ type: 'message_stop' }),
      ],
      async (base) => {
        const result = await complete(input('anthropic', base));
        expect(result).toMatchObject({ text: 'hello', inputTokens: 7, outputTokens: 3 });
        expect(result.toolCalls[0].name).toBe('list_files');
      },
    );
  });
  it('parses Gemini visible text and function calls', async () => {
    await serve(
      [
        event({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'private thought', thought: true },
                  { text: 'hello' },
                  { functionCall: { name: 'list_files', args: { path: '' } } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
        }),
      ],
      async (base, reqs) => {
        const result = await complete(input('gemini', base));
        expect(result.text).toBe('hello');
        expect(result.toolCalls[0].name).toBe('list_files');
        expect(reqs[0].path).toContain(':streamGenerateContent?alt=sse');
      },
    );
  });
  it('fails closed on incomplete streams and malformed tool arguments', async () => {
    await serve([event({ choices: [{ delta: { content: 'partial' } }] })], async (base) => {
      await expect(complete(input('openai-chat', base))).rejects.toThrow('中断');
    });
    await serve(
      [
        event({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'x', function: { name: 'write_file', arguments: '{"path"' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ],
      async (base) => {
        await expect(complete(input('openai-chat', base))).rejects.toThrow('参数不完整');
      },
    );
  });
  it('never executes truncated tool output even if a done marker is present', async () => {
    await serve(
      [event({ choices: [{ delta: {}, finish_reason: 'length' }] }), 'data: [DONE]\n\n'],
      async (base) => {
        await expect(complete(input('openai-chat', base))).rejects.toThrow('单次输出达到上限');
      },
    );
  });
  it('identifies the configured limit without claiming a tool was called for text-only truncation', async () => {
    await serve(
      [event({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] })],
      async (base) => {
        const error = await complete(input('openai-chat', base)).catch((e) => e);
        expect(error.message).toContain('1,024 Tokens');
        expect(error.message).toContain('连接中心 → 编辑该连接');
        expect(error.message).toContain('已收到的正文已保留');
        expect(error.message).not.toContain('工具调用未执行');
      },
    );
  });
  it.each(['max_output_tokens', 'content_filter'])(
    'preserves the Responses incomplete reason %s',
    async (reason) => {
      await serve(
        [event({ type: 'response.incomplete', response: { incomplete_details: { reason } } })],
        async (base) => {
          await expect(complete(input('openai-responses', base))).rejects.toThrow(
            reason === 'max_output_tokens' ? '1,024 Tokens' : 'content_filter',
          );
        },
      );
    },
  );
});
describe('portable history and protocol mapping', () => {
  it('carries foreign tool evidence without replaying account-specific calls', () => {
    const messages: Message[] = [
      message,
      {
        ...message,
        role: 'assistant',
        model: 'other',
        providerId: 'old',
        content: '',
        toolCalls: [
          {
            id: 'old-call',
            name: 'read_file',
            arguments: '{"path":"a"}',
            signature: 'opaque',
            signatureModel: 'other',
          },
        ],
      },
      {
        ...message,
        role: 'tool',
        toolCallId: 'old-call',
        toolName: 'read_file',
        content: 'evidence',
      },
    ];
    for (const protocol of [
      'openai-chat',
      'openai-responses',
      'anthropic',
      'gemini',
    ] as Protocol[]) {
      const serialized = JSON.stringify(requestBody({ ...input(protocol), messages }).body);
      expect(serialized).toContain('evidence');
      expect(serialized).toContain('read_file');
      expect(serialized).not.toContain('old-call');
      expect(serialized).not.toContain('opaque');
    }
  });
  it('normalizes native Codex activity into portable history evidence', () => {
    const history = portableHistory(
      [message, { ...message, role: 'tool', toolName: 'command', content: 'build passed' }],
      10000,
    );
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toContain('build passed');
  });
  it('recovers an interrupted tool batch without sending orphan calls or replaying operations', () => {
    const messages: Message[] = [
      message,
      {
        ...message,
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'done', name: 'write_file', arguments: '{}' },
          { id: 'unknown', name: 'run_command', arguments: '{}' },
        ],
      },
      { ...message, role: 'tool', toolCallId: 'done', content: 'file saved' },
      { ...message, content: 'continue' },
    ];
    const body = requestBody({ ...input('openai-chat'), messages }).body as any;
    expect(body.messages.every((m: any) => !m.tool_calls && m.role !== 'tool')).toBe(true);
    expect(JSON.stringify(body)).toContain('结果未记录');
    expect(JSON.stringify(body)).toContain('file saved');
  });
  it('retains Gemini tool signatures within the same model and provider', () => {
    const messages: Message[] = [
      message,
      {
        ...message,
        role: 'assistant',
        model: 'test',
        providerId: 'p',
        content: '',
        toolCalls: [
          {
            id: 'c',
            name: 'list_files',
            arguments: '{}',
            signature: 'opaque',
            signatureModel: 'test',
          },
        ],
      },
      { ...message, role: 'tool', toolCallId: 'c', toolName: 'list_files', content: '[]' },
    ];
    expect(JSON.stringify(requestBody({ ...input('gemini'), messages }).body)).toContain('opaque');
  });
  it('keeps call/result pairs and sends oversized user input without a local rejection', () => {
    const history = [
      message,
      {
        ...message,
        id: 'a',
        role: 'assistant' as const,
        content: 'x'.repeat(500),
        toolCalls: [{ id: 't', name: 'read_file', arguments: '{}' }],
      },
      { ...message, id: 't', role: 'tool' as const, toolCallId: 't', content: 'result' },
      { ...message, id: 'new', content: 'next' },
    ];
    expect(portableHistory(history, 500)).toEqual([history[0], history[3]]);
    expect(portableHistory([{ ...message, content: 'x'.repeat(1000) }], 500)[0].content).toBe(
      'x'.repeat(1000),
    );
  });
  it('pairs tool calls and tool responses in all protocols', () => {
    const messages = [
      message,
      {
        ...message,
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'c', name: 'read_file', arguments: '{"path":"x"}' }],
      },
      {
        ...message,
        role: 'tool' as const,
        toolCallId: 'c',
        toolName: 'read_file',
        content: 'value',
      },
    ];
    const response = requestBody({ ...input('openai-responses'), messages }).body as any;
    expect(response.input.at(-1)).toEqual({
      type: 'function_call_output',
      call_id: 'c',
      output: 'value',
    });
    const anthropic = requestBody({ ...input('anthropic'), messages }).body as any;
    expect(anthropic.messages.at(-1).content[0].tool_use_id).toBe('c');
    const gemini = requestBody({ ...input('gemini'), messages }).body as any;
    expect(gemini.contents.at(-1).parts[0].functionResponse.name).toBe('read_file');
  });
  it('uses protocol-specific auth headers and rejects missing secrets', () => {
    const p = input('anthropic').provider;
    expect(headers({ ...p, auth: 'api-key' }, 'key')['x-api-key']).toBe('key');
    expect(headers({ ...p, auth: 'bearer' }, 'key').Authorization).toBe('Bearer key');
    expect(() => headers({ ...p, auth: 'api-key' }, '')).toThrow('保存');
  });
});
