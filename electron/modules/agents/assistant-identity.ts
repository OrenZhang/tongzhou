import common from '../../../prompts/common.json';

export const greetingReply = common.greeting;
export const introductionReply = common.introduction;
export const builtinReplyModel = '同舟内置回复';

/** Match entire standalone utterances only; never rewrite task text or quoted material. */
export function identityReply(prompt: string): string | undefined {
  const text = prompt
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？]+$/u, '')
    .trim();
  const greeting = '(?:你好(?:呀|啊)?|您好|嗨|哈喽|早上好|下午好|晚上好|hello|hi|hey)';
  if (new RegExp(`^(?:同舟[，,\\s]*)?${greeting}(?:[，,\\s]*同舟)?$`, 'u').test(text))
    return greetingReply;
  if (
    new RegExp(
      `^(?:${greeting}[，,\\s]*)?(?:请问)?(?:你是谁|你叫什么(?:名字)?|你的名字(?:是什么)?|你是什么助手|你是哪个助手|介绍一下你自己|介绍一下自己|自我介绍一下|who are you|what is your name|what's your name)$`,
      'u',
    ).test(text)
  )
    return introductionReply;
}

export function identityInstructions(model: string): string {
  const values: Record<string, string> = {
    greeting: greetingReply,
    introduction: introductionReply,
    model: JSON.stringify(model),
  };
  return common.instructions
    .join('\n')
    .replace(/\{\{(greeting|introduction|model)\}\}/g, (_, key) => values[key]);
}
