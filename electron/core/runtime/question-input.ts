import { z } from 'zod';
import type { QuestionAnswers, UserQuestion } from '../../../src/shared/agent-execution';

export const questionsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(100),
      header: z.string().max(100),
      question: z.string().min(1).max(8000),
      isOther: z.boolean().default(false),
      isSecret: z.boolean().default(false),
      options: z
        .array(z.object({ label: z.string().min(1).max(1000), description: z.string().max(4000) }))
        .max(20)
        .nullable(),
    }),
  )
  .min(1)
  .max(3)
  .refine(
    (questions) => new Set(questions.map((q) => q.id)).size === questions.length,
    '问题 ID 重复',
  );

export function validateQuestionAnswers(
  questions: UserQuestion[],
  value: unknown,
): QuestionAnswers | null {
  const answers = z
    .record(z.string(), z.array(z.string().min(1).max(8000)).min(1).max(10))
    .nullable()
    .parse(value);
  if (answers === null) return null;
  if (Object.keys(answers).length !== questions.length) throw new Error('请回答所有问题');
  for (const question of questions) {
    const reply = answers[question.id];
    if (!reply?.length) throw new Error('请回答所有问题');
    if (
      question.options?.length &&
      !question.isOther &&
      reply.some((text) => !question.options!.some((option) => option.label === text))
    )
      throw new Error('请选择问题提供的选项');
  }
  return answers;
}
