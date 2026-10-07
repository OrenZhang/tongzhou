import { describe, it, expect, vi } from 'vitest';
import {
  thinkingRequest,
  codexThinking,
  nativeThinking,
} from '../../../electron/core/runtime/thinking';
import { requestBody, type CompletionInput } from '../../../electron/core/models/providers';
import { Store } from '../../../electron/services/storage/store';
import { providerSchema } from '../../../electron/services/storage/validation';
import type { Provider } from '../../../src/shared/types';

const provider: Provider = {
  id: 'p',
  name: 'test',
  protocol: 'openai-chat',
  baseUrl: 'https://example.invalid/v1',
  auth: 'none',
  models: [],
  maxOutputTokens: 8192,
  contextChars: 0,
};
function input(p: Provider, model: string): CompletionInput {
  return {
    provider: p,
    model,
    instructions: 'test',
    secret: '',
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    onDelta() {},
  };
}
describe('connection-level model thinking', () => {
  it('defaults both legacy and new connections on and preserves an explicit off on partial saves', () => {
    const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
    try {
      store.put('provider', provider);
      expect(store.providers().find((p) => p.id === 'p')!.thinkingEnabled).toBe(true);
      store.saveProvider(providerSchema.parse({ ...provider, thinkingEnabled: false }));
      store.saveProvider(provider);
      expect(store.providers().find((p) => p.id === 'p')!.thinkingEnabled).toBe(false);
      expect(store.saveProvider({ ...provider, id: 'new' }).thinkingEnabled).toBe(true);
    } finally {
      store.close();
    }
  });
  it.each(['openai-chat', 'openai-responses'] as const)(
    'sends reasoning parameters through %s without legacy OpenAI token names',
    (protocol) => {
      const p = { ...provider, protocol };
      const body: any = requestBody(input(p, 'gpt-5.2')).body;
      expect(protocol === 'openai-chat' ? body.reasoning_effort : body.reasoning.effort).toBe(
        'medium',
      );
      const off: any = requestBody(input({ ...p, thinkingEnabled: false }, 'gpt-5.2')).body;
      expect(protocol === 'openai-chat' ? off.reasoning_effort : off.reasoning.effort).toBe('none');
      if (protocol === 'openai-chat') {
        expect(body.max_tokens).toBeUndefined();
        expect(body.max_completion_tokens).toBe(8192);
      }
    },
  );
  it('uses the actual Codex model capabilities, including models which cannot disable reasoning', () => {
    const model = {
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
        reasoningEffort,
      })),
    };
    expect(codexThinking(model).effort).toBe('medium');
    expect(codexThinking(model, false)).toMatchObject({
      effort: 'low',
      note: expect.stringContaining('不能关闭'),
    });
    expect(
      codexThinking(
        {
          ...model,
          supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'high' }],
        },
        false,
      ).effort,
    ).toBe('none');
  });
  it('uses native engine advertised config values rather than inventing a thinking command', async () => {
    const client = { request: vi.fn(async () => ({})) };
    const state = {
      configOptions: [
        {
          id: 'thinking',
          category: 'thought_level',
          currentValue: 'off',
          options: [{ value: 'off' }, { value: 'on' }],
        },
      ],
    };
    await nativeThinking(client, 's', state);
    expect(client.request).toHaveBeenLastCalledWith('session/set_config_option', {
      sessionId: 's',
      configId: 'thinking',
      value: 'on',
    });
    await nativeThinking(client, 's', state, false);
    expect(client.request).toHaveBeenLastCalledWith('session/set_config_option', {
      sessionId: 's',
      configId: 'thinking',
      value: 'off',
    });
    client.request.mockClear();
    expect(await nativeThinking(client, 's', {})).toContain('引擎默认');
    expect(client.request).not.toHaveBeenCalled();
  });
  it('handles Claude adaptive/manual thinking and enforces an adequate output budget', () => {
    const p = { ...provider, protocol: 'anthropic' as const };
    expect(thinkingRequest(p, 'claude-sonnet-4-6').body.thinking.type).toBe('adaptive');
    expect(thinkingRequest(p, 'claude-sonnet-4-5').body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    });
    expect(
      thinkingRequest({ ...p, thinkingEnabled: false }, 'claude-sonnet-4-6').body.thinking.type,
    ).toBe('disabled');
    expect(() => thinkingRequest({ ...p, maxOutputTokens: 1024 }, 'claude-sonnet-4-5')).toThrow(
      '2048',
    );
  });
  it('enables DeepSeek/Kimi chat thinking and Gemini budgets while leaving unknown gateways unchanged', () => {
    expect(thinkingRequest(provider, 'deepseek-chat').body).toEqual({
      thinking: { type: 'enabled' },
    });
    expect(thinkingRequest({ ...provider, thinkingEnabled: false }, 'kimi-k2.5').body).toEqual({
      thinking: { type: 'disabled' },
    });
    const g = { ...provider, protocol: 'gemini' as const };
    const b: any = requestBody(input(g, 'gemini-2.5-flash')).body;
    expect(b.generationConfig.thinkingConfig.thinkingBudget).toBe(-1);
    expect(
      thinkingRequest({ ...g, thinkingEnabled: false }, 'gemini-2.5-flash').body.thinkingConfig
        .thinkingBudget,
    ).toBe(0);
    expect(thinkingRequest({ ...g, thinkingEnabled: false }, 'gemini-3.1-pro').note).toContain(
      '不能',
    );
    expect(thinkingRequest(provider, 'my-custom-model').body).toEqual({});
    expect(thinkingRequest(provider, 'my-custom-model').note).toContain('服务默认');
  });
  it('replays vendor reasoning only to the same connection and model', () => {
    const req = input(provider, 'deepseek-chat');
    req.messages = [
      {
        id: 'a',
        sessionId: 's',
        role: 'assistant',
        content: '',
        createdAt: 1,
        providerId: 'p',
        model: 'deepseek-chat',
        reasoningContent: 'tool reasoning',
        toolCalls: [{ id: 't', name: 'read_file', arguments: '{}' }],
      },
      { id: 'b', sessionId: 's', role: 'tool', content: 'ok', createdAt: 2, toolCallId: 't' },
    ];
    expect((requestBody(req).body as any).messages[1].reasoning_content).toBe('tool reasoning');
    expect(
      (requestBody({ ...req, model: 'another-model' }).body as any).messages[1].reasoning_content,
    ).toBeUndefined();
    const responses = input({ ...provider, protocol: 'openai-responses' }, 'gpt-5.2');
    responses.messages = [
      {
        ...req.messages[0],
        model: 'gpt-5.2',
        responseReasoning: [
          { id: 'rs', type: 'reasoning', encrypted_content: 'opaque', summary: [] },
        ],
      },
      req.messages[1],
    ];
    expect((requestBody(responses).body as any).input[0]).toMatchObject({
      type: 'reasoning',
      encrypted_content: 'opaque',
    });
    expect(
      JSON.stringify(
        requestBody({ ...responses, provider: { ...responses.provider, id: 'other' } }).body,
      ),
    ).not.toContain('opaque');
  });
});
