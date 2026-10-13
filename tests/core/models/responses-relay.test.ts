import { describe, it, expect, vi } from 'vitest';
import { modelGateway } from '../../../electron/core/models/model-gateway';
import type { Provider } from '../../../src/shared/types';

const provider: Provider = {
  id: 'p',
  name: 'gateway',
  protocol: 'openai-responses',
  auth: 'api-key',
  baseUrl: 'https://models.invalid/v1/',
  models: ['gpt-6-sol'],
  maxOutputTokens: 8192,
  contextChars: 0,
  reasoningEffort: 'high',
};
const event = (value: any) => 'data: ' + JSON.stringify(value) + '\n\n';
const success = {
  type: 'response.completed',
  sequence_number: 3,
  response: {
    id: 'resp_upstream',
    status: 'completed',
    output: [],
    usage: { input_tokens: 30, output_tokens: 12 },
  },
};
async function relay(transport: typeof fetch, body: any, p = provider) {
  const gateway = await modelGateway({
    sessionId: 's',
    resolve: async () => ({ provider: p, model: 'gpt-6-sol', secret: 'test-secret' }),
    transport,
  });
  try {
    const response = await fetch(gateway.baseUrl + '/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + gateway.token },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  } finally {
    gateway.close();
  }
}
describe('native Responses relay', () => {
  it('keeps non-GPT-6 Responses models on the compatible tool adapter', async () => {
    const transport = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.instructions).toBe('system');
      expect(body.tools[0]).toMatchObject({
        type: 'function',
        name: expect.stringMatching(/^tz_/),
      });
      expect(body.input).toEqual([{ role: 'user', content: 'read' }]);
      return new Response(
        event({ type: 'response.output_text.delta', delta: 'ok' }) + event(success),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;
    const gateway = await modelGateway({
      sessionId: 's',
      transport,
      resolve: async () => ({ provider, model: 'compatible-model', secret: 'test-secret' }),
    });
    try {
      const response = await fetch(gateway.baseUrl + '/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + gateway.token },
        body: JSON.stringify({
          input: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'read' },
          ],
          tools: [{ type: 'namespace', name: 'files', tools: [{ type: 'custom', name: 'read' }] }],
        }),
      });
      expect(await response.text()).toContain('response.completed');
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      gateway.close();
    }
  });
  it('aborts the upstream request when the local client disconnects', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const aborted = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const gateway = await modelGateway({
      sessionId: 's',
      resolve: async () => ({ provider, model: 'gpt-6-sol', secret: 'test-secret' }),
      transport: ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => {
            cancelled();
            reject(new Error('aborted'));
          });
          started();
        })) as typeof fetch,
    });
    try {
      const controller = new AbortController();
      const pending = fetch(gateway.baseUrl + '/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + gateway.token },
        body: JSON.stringify({ input: [], tools: [] }),
        signal: controller.signal,
      });
      const rejected = expect(pending).rejects.toThrow();
      await ready;
      controller.abort();
      await rejected;
      await aborted;
    } finally {
      gateway.close();
    }
  });
  it('preserves staged tools, custom grammar, roles, reasoning IDs and stream identities', async () => {
    const body = {
      model: 'local-alias',
      input: [
        { type: 'message', role: 'system', content: 'system' },
        { type: 'message', role: 'developer', content: 'developer' },
        { type: 'reasoning', id: 'rs_prior', encrypted_content: 'opaque' },
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'namespace',
              name: 'files',
              tools: [
                {
                  type: 'custom',
                  name: 'patch',
                  format: { type: 'grammar', syntax: 'lark', definition: 'start: TEXT' },
                },
              ],
            },
          ],
        },
      ],
      tools: [],
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['message.output_text.logprobs'],
      text: { verbosity: 'low' },
      parallel_tool_calls: false,
      tool_choice: 'auto',
    };
    const delta = {
      type: 'response.output_text.delta',
      item_id: 'msg_native',
      delta: '你好',
      sequence_number: 2,
    };
    const transport = vi.fn(async (url, init) => {
      expect(url).toBe('https://models.invalid/v1/responses');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-secret' });
      expect(init.redirect).toBe('error');
      const request = JSON.parse(init.body as string);
      expect(request).toEqual({
        ...body,
        model: 'gpt-6-sol',
        stream: true,
        store: false,
        max_output_tokens: 8192,
        reasoning: { effort: 'high', summary: 'auto' },
        include: ['message.output_text.logprobs', 'reasoning.encrypted_content'],
      });
      return new Response(event(delta) + event(success), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    expect((await relay(transport, body)).text).toBe(event(delta) + event(success));
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['disconnect', 'incomplete', 'failed'])(
    'does not release tool calls on %s or retry them',
    async (failure) => {
      const tool = {
        id: 'fc_native',
        type: 'custom_tool_call',
        name: 'patch',
        call_id: 'c',
        input: 'write',
      };
      const text = event({ type: 'response.output_text.delta', delta: '已检查' });
      const tail =
        failure === 'disconnect'
          ? ''
          : failure === 'incomplete'
            ? event({
                type: 'response.incomplete',
                response: { incomplete_details: { reason: 'max_output_tokens' } },
              })
            : event({
                type: 'response.failed',
                response: { error: { message: 'bad test-secret' } },
              });
      const transport = vi.fn(
        async () =>
          new Response(
            text +
              event({ type: 'response.output_item.added', item: tool }) +
              event({ type: 'response.output_item.done', item: tool }) +
              tail,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ) as unknown as typeof fetch;
      const result = await relay(transport, { input: [], tools: [] });
      expect(result.text).toContain('已检查');
      expect(result.text).toContain('response.failed');
      expect(result.text).not.toContain('custom_tool_call');
      expect(result.text).not.toContain('test-secret');
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it('releases complete tools in the original event order only on confirmed success', async () => {
    const tool = {
      id: 'fc_native',
      type: 'function_call',
      call_id: 'c',
      name: 'read',
      arguments: '{}',
    };
    let finish!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            event({ type: 'response.output_item.added', item: tool }) +
              event({ type: 'response.output_item.done', item: tool }),
          ),
        );
        finish = () => {
          controller.enqueue(new TextEncoder().encode(event(success)));
          controller.close();
        };
      },
    });
    const gateway = await modelGateway({
      sessionId: 's',
      resolve: async () => ({ provider, model: 'gpt-6-sol', secret: 'test-secret' }),
      transport: (async () =>
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
    });
    try {
      const response = await fetch(gateway.baseUrl + '/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + gateway.token },
        body: JSON.stringify({ input: [], tools: [] }),
      });
      const reader = response.body!.getReader();
      let received = false;
      const first = reader.read().then((value) => {
        received = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toBe(false);
      finish();
      let wire = new TextDecoder().decode((await first).value);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        wire += new TextDecoder().decode(chunk.value);
      }
      expect(wire).toBe(
        event({ type: 'response.output_item.added', item: tool }) +
          event({ type: 'response.output_item.done', item: tool }) +
          event(success),
      );
    } finally {
      gateway.close();
    }
  });
  it('redacts upstream HTTP errors and does not retry or silently convert protocols', async () => {
    const transport = vi.fn(
      async () => new Response('test-secret unsupported', { status: 400 }),
    ) as unknown as typeof fetch;
    const result = await relay(transport, { input: [], tools: [] });
    expect(result.status).toBe(400);
    expect(result.text).toContain('unsupported');
    expect(result.text).not.toContain('test-secret');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
