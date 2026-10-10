import type { Provider } from '../../../src/shared/types';

/** Only emit documented parameters for recognized model/protocol pairs. */
export function thinkingRequest(
  p: Provider,
  model: string,
): { body: Record<string, any>; note?: string } {
  const on = p.thinkingEnabled !== false;
  const m = model.toLowerCase().replace(/^.*\//, '');
  const fixed = '所选模型不能彻底关闭思考，已使用支持的最低强度。';
  if (['openai-chat', 'openai-responses'].includes(p.protocol)) {
    if (/^(gpt-[56](?:[.-]|$)|o[134](?:[-.]|$))/.test(m) && !m.includes('chat')) {
      const canOff = /^gpt-5\.[1-9]/.test(m) || /^gpt-6.*(?:sol|luna)/.test(m);
      const effort = on ? 'medium' : canOff ? 'none' : 'low';
      return {
        body:
          p.protocol === 'openai-chat'
            ? { reasoning_effort: effort }
            : {
                reasoning: { effort, ...(on ? { summary: 'auto' } : {}) },
                include: ['reasoning.encrypted_content'],
              },
        ...(!on && !canOff ? { note: fixed } : {}),
      };
    }
    if (
      p.protocol === 'openai-chat' &&
      /^(deepseek-(?:chat|reasoner|v[34])|kimi-k2[.][5-9])/.test(m)
    ) {
      return {
        body: { thinking: { type: on ? 'enabled' : 'disabled' } },
      };
    }
  }
  if (p.protocol === 'anthropic' && /^claude-/.test(m)) {
    const adaptive =
      /^claude-(?:opus|sonnet)-4[.-][6-9]/.test(m) ||
      /^claude-(?:opus|sonnet|fable|mythos)-5(?:[-.]|$)/.test(m) ||
      /^claude-mythos/.test(m);
    const manual =
      /^claude-(?:3-7-sonnet|(?:opus|sonnet|haiku)-4|(?:opus|sonnet)-4-[015])(?:[-.]|$)/.test(m);
    if (adaptive || manual) {
      const always = /^claude-(?:mythos|fable)/.test(m) || /^claude-(?:opus|sonnet)-5[.-]5/.test(m);
      if (!on && !always) return { body: { thinking: { type: 'disabled' } } };
      if (adaptive)
        return {
          body: { thinking: { type: 'adaptive', display: 'summarized' } },
          ...(!on ? { note: '此模型始终启用思考，关闭选项不适用。' } : {}),
        };
      if (p.maxOutputTokens < 2048)
        throw new Error(
          '此 Claude 模型开启思考需要至少 2048 的单次最大输出 Tokens，请在模型调整。',
        );
      return {
        body: {
          thinking: {
            type: 'enabled',
            budget_tokens: Math.min(8192, Math.floor(p.maxOutputTokens / 2)),
          },
        },
      };
    }
  }
  if (p.protocol === 'gemini' && /^gemini-(?:2\.5|3)/.test(m) && !/(image|tts|live)/.test(m)) {
    if (/^gemini-2\.5/.test(m)) {
      const always = m.includes('pro');
      return {
        body: {
          thinkingConfig: { thinkingBudget: on ? -1 : always ? 128 : 0, includeThoughts: on },
        },
        ...(!on && always ? { note: fixed } : {}),
      };
    }
    return {
      body: { thinkingConfig: { thinkingLevel: on ? 'high' : 'low', includeThoughts: on } },
      ...(!on ? { note: fixed } : {}),
    };
  }
  return { body: {} };
}

export function codexThinking(model: any, enabled = true): { effort?: string; note?: string } {
  const options: string[] = (model?.supportedReasoningEfforts ?? []).map(
    (o: any) => o.reasoningEffort,
  );
  if (!options.length) return {};
  if (!enabled && options.includes('none')) return { effort: 'none' };
  const positive = options.filter((v) => v !== 'none');
  if (!positive.length)
    return { effort: options[0], note: '此模型不支持思考，已使用模型支持的模式。' };
  const effort = enabled
    ? positive.includes('medium')
      ? 'medium'
      : positive.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : positive[0]
    : (['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].find((v) =>
        positive.includes(v),
      ) ?? positive[0]);
  return { effort, ...(!enabled ? { note: '此模型不能关闭思考，已使用支持的最低强度。' } : {}) };
}
