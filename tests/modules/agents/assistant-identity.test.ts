import { describe, expect, it } from 'vitest';
import {
  identityReply,
  greetingReply,
  introductionReply,
  identityInstructions,
} from '../../../electron/modules/agents/assistant-identity';

describe('Tongzhou identity routing', () => {
  it.each(['你好', '您好！', '你好，同舟', 'Hi', '同舟，晚上好。'])(
    'normalizes a standalone greeting: %s',
    (text) => {
      expect(identityReply(text)).toBe(greetingReply);
    },
  );
  it.each(['你是谁？', '你好，你叫什么名字？', '请问你是谁', '介绍一下自己', 'Who are you?'])(
    'normalizes an identity question: %s',
    (text) => {
      expect(identityReply(text)).toBe(introductionReply);
    },
  );
  it.each([
    '你好，帮我修复代码',
    '把“你好”翻译成英文',
    '“你是谁”是什么意思',
    '你是谁？然后检查项目',
    '你是什么模型',
    '你是 OpenAI 的模型吗',
    '创建 hello.txt',
  ])('preserves real tasks and model questions: %s', (text) => {
    expect(identityReply(text)).toBeUndefined();
  });
  it('does not expand placeholder-like text in a model identifier', () => {
    expect(identityInstructions('{{greeting}}')).toContain('"{{greeting}}"');
  });
});
