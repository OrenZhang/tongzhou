import { describe, it, expect } from 'vitest';
import { decodeModelRequest, modelGateway } from '../../../electron/core/models/model-gateway';
import type { Provider } from '../../../src/shared/types';
const provider: Provider = {
  id: 'p',
  name: 'p',
  protocol: 'anthropic',
  auth: 'none',
  baseUrl: 'https://unused.invalid',
  models: ['m'],
  maxOutputTokens: 1000,
  contextChars: 0,
};
describe('Codex model protocol gateway', () => {
  it('preserves call/result identities and disambiguates namespaced/custom tools', () => {
    const decoded = decodeModelRequest(
      {
        instructions: 'system',
        tools: [
          { type: 'function', name: 'read', parameters: { type: 'object' } },
          {
            type: 'namespace',
            name: 'files',
            tools: [
              {
                type: 'custom',
                name: 'read',
                format: { type: 'grammar', syntax: 'lark', definition: 'start: TEXT' },
              },
            ],
          },
        ],
        input: [
          { role: 'developer', content: 'developer' },
          {
            type: 'custom_tool_call',
            namespace: 'files',
            name: 'read',
            call_id: 'c',
            input: 'raw text',
          },
          { type: 'custom_tool_call_output', call_id: 'c', output: 'result' },
        ],
      },
      's',
    );
    expect(decoded.instructions).toBe('system\n\ndeveloper');
    expect(decoded.tools[0].name).toBe('read');
    expect(decoded.tools[1].name).not.toBe('read');
    expect(decoded.tools[1].description).toContain('lark');
    expect(decoded.messages[0].toolCalls?.[0]).toMatchObject({
      id: 'c',
      arguments: '{"input":"raw text"}',
    });
    expect(decoded.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'c', content: 'result' });
  });
  it('rejects unsupported content without silently removing it', () => {
    expect(() =>
      decodeModelRequest(
        { input: [{ type: 'message', role: 'user', content: [{ type: 'input_audio' }] }] },
        's',
      ),
    ).toThrow('不支持输入类型');
  });
  it('closes interleaved text and reasoning items without repeating final text', async () => {
    const gateway = await modelGateway({
      sessionId: 's',
      resolve: async () => ({ provider, model: 'm', secret: '' }),
      complete: async (input) => {
        input.onDelta('先检查。');
        input.onReasoning?.('检查完成。');
        input.onDelta('结果正常。');
        return { text: '先检查。结果正常。', toolCalls: [], inputTokens: 1, outputTokens: 1 };
      },
    });
    try {
      const response = await fetch(gateway.baseUrl + '/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + gateway.token },
        body: JSON.stringify({ input: [], tools: [] }),
      });
      const events = (await response.text())
        .split('\n')
        .filter((s) => s.startsWith('data: '))
        .map((s) => JSON.parse(s.slice(6)));
      const done = events.filter((e) => e.type === 'response.output_item.done');
      expect(done.map((e) => e.item.type)).toEqual(['message', 'reasoning', 'message']);
      expect(new Set(done.map((e) => e.item.id)).size).toBe(3);
      expect(
        done.filter((e) => e.item.type === 'message').map((e) => e.item.content[0].text),
      ).toEqual(['先检查。', '结果正常。']);
      let activeId: string | undefined;
      for (const event of events) {
        if (event.type === 'response.output_item.added') {
          expect(activeId).toBeUndefined();
          activeId = event.item.id;
        } else if (event.type === 'response.output_item.done') {
          expect(activeId).toBe(event.item.id);
          activeId = undefined;
        } else if (event.item_id) expect(event.item_id).toBe(activeId);
      }
      expect(activeId).toBeUndefined();
    } finally {
      gateway.close();
    }
  });
  it('authenticates loopback requests and restores provider-private signatures after restart', async () => {
    const state = {
      signature: 'gemini-signature',
      signatureModel: 'm',
      anthropicContent: [
        { type: 'thinking', thinking: 'private', signature: 'opaque' },
        { type: 'tool_use', id: 'c', name: 'read', input: {} },
      ],
    };
    let calls = 0;
    const gateway = await modelGateway({
      sessionId: 's',
      resolve: async () => ({ provider, model: 'm', secret: '' }),
      loadState: () => state,
      complete: async (input) => {
        calls++;
        expect(input.messages[0]).toMatchObject({
          anthropicContent: state.anthropicContent,
          providerId: 'p',
          model: 'm',
        });
        expect(input.messages[0].toolCalls?.[0]).toMatchObject({
          signature: state.signature,
          signatureModel: 'm',
        });
        return { text: 'done', toolCalls: [], inputTokens: 1, outputTokens: 1 };
      },
    });
    try {
      expect(
        (await fetch(gateway.baseUrl + '/responses', { method: 'POST', body: '{}' })).status,
      ).toBe(403);
      const response = await fetch(gateway.baseUrl + '/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + gateway.token },
        body: JSON.stringify({
          tools: [{ type: 'function', name: 'read' }],
          input: [
            { type: 'function_call', name: 'read', call_id: 'c', arguments: '{}' },
            { type: 'function_call_output', call_id: 'c', output: 'done' },
          ],
        }),
      });
      expect(await response.text()).toContain('response.completed');
      expect(calls).toBe(1);
    } finally {
      gateway.close();
    }
  });
});
