import { describe, it, expect } from 'vitest';
import { thinkingRequest, codexThinking } from '../../../electron/core/runtime/thinking';
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
  it('defaults connections on and preserves an explicit off on partial saves', () => {
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
    expect(codexThinking(model).effort).toBe('high');
    expect(codexThinking(model, true, 'medium').effort).toBe('medium');
    expect(() => codexThinking(model, true, 'max')).toThrow('不支持思考强度');
    expect(() => codexThinking({}, true, 'high')).toThrow('未提供思考强度');
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
  it.each(['openai-chat', 'openai-responses'] as const)(
    'retains the requested GPT-6 effort across validation, storage and %s serialization',
    (protocol) => {
      const store = new Store(':memory:', { encrypt: (value) => value, decrypt: (value) => value });
      try {
        const saved = store.saveProvider(
          providerSchema.parse({ ...provider, protocol, reasoningEffort: 'high' }),
        );
        const body: any = requestBody(input(saved, 'gpt-6-sol')).body;
        expect(protocol === 'openai-chat' ? body.reasoning_effort : body.reasoning.effort).toBe(
          'high',
        );
        expect(providerSchema.safeParse({ ...provider, reasoningEffort: 'invented' }).success).toBe(
          false,
        );
        expect(
          thinkingRequest({ ...saved, thinkingEnabled: false }, 'gpt-6-sol').body,
        ).toMatchObject(
          protocol === 'openai-chat'
            ? { reasoning_effort: 'none' }
            : { reasoning: { effort: 'none' } },
        );
        expect(
          thinkingRequest({ ...saved, thinkingEnabled: false }, 'gpt-6.1-sol').body,
        ).toMatchObject(
          protocol === 'openai-chat'
            ? { reasoning_effort: 'low' }
            : { reasoning: { effort: 'low' } },
        );
      } finally {
        store.close();
      }
    },
  );
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
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'serializes Claude adaptive effort %s without changing defaults',
    (reasoningEffort) => {
      const p = {
        ...provider,
        protocol: 'anthropic' as const,
        reasoningEffort,
        thinkingBudgetTokens: 2048,
      };
      const body: any = requestBody(input(p, 'claude-opus-4-8')).body;
      expect(body.output_config).toEqual({ effort: reasoningEffort });
      expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(
        thinkingRequest({ ...p, reasoningEffort: undefined }, 'claude-sonnet-4-6').body,
      ).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
      expect(thinkingRequest(p, 'claude-sonnet-4-6').body.output_config.effort).toBe(
        reasoningEffort === 'xhigh' ? 'high' : reasoningEffort,
      );
    },
  );
  it('retains explicit manual budgets through storage and leaves off/unknown models unchanged', () => {
    const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
    try {
      const p = store.saveProvider(
        providerSchema.parse({
          ...provider,
          protocol: 'anthropic',
          thinkingBudgetTokens: 6144,
          reasoningEffort: 'high',
        }),
      );
      const body: any = requestBody(input(p, 'claude-opus-4-5')).body;
      expect(body.thinking.budget_tokens).toBe(6144);
      expect(body.output_config.effort).toBe('high');
      expect(thinkingRequest(p, 'claude-sonnet-4-5').body.output_config).toBeUndefined();
      expect(thinkingRequest({ ...p, thinkingEnabled: false }, 'claude-sonnet-4-5').body).toEqual({
        thinking: { type: 'disabled' },
      });
      expect(
        thinkingRequest({ ...p, thinkingEnabled: false }, 'claude-opus-5-5').body.output_config
          .effort,
      ).toBe('low');
      expect(thinkingRequest(p, 'custom-claude').body).toEqual({});
      expect(() =>
        thinkingRequest({ ...p, thinkingBudgetTokens: 8192 }, 'claude-sonnet-4-5'),
      ).toThrow('小于');
      expect(providerSchema.safeParse({ ...p, thinkingBudgetTokens: 512 }).success).toBe(false);
    } finally {
      store.close();
    }
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
    expect(thinkingRequest(provider, 'my-custom-model').note).toBeUndefined();
    expect(codexThinking({})).toEqual({});
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

describe('automatic routing reasoning compatibility', () => {
  it('maps automatic effort to actual catalog capabilities without relaxing fixed selections', () => {
    const model = {
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    };
    expect(codexThinking(model, true, 'max', false)).toMatchObject({ effort: 'high' });
    expect(codexThinking(model, true, 'medium', false)).toMatchObject({ effort: 'low' });
    expect(codexThinking({}, true, 'high', false)).toEqual({});
    expect(() => codexThinking(model, true, 'max')).toThrow('不支持思考强度');
  });
});
