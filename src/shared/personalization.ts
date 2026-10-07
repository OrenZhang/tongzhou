export interface PreferenceReference {
  documentId: string;
  entryId: string;
  fingerprint: string;
}
export interface Personalization {
  version: number;
  enabled: boolean;
  soul: string;
  userPreferences: string;
  memories: PreferenceReference[];
  reply?: ReplyPreferences;
}
export interface ReplyPreferences {
  name: string;
  language: 'auto' | 'zh' | 'en';
  length: 'auto' | 'concise' | 'detailed';
  tone: 'auto' | 'direct' | 'friendly';
}
export const defaultReply: ReplyPreferences = {
  name: '',
  language: 'auto',
  length: 'auto',
  tone: 'auto',
};
export const replyOptions = {
  language: { auto: '跟随当前对话', zh: '中文', en: '英文' },
  length: { auto: '按问题需要', concise: '简短，先给结论', detailed: '详细，补充解释和例子' },
  tone: { auto: '同舟默认风格', direct: '直接、专业', friendly: '自然、耐心' },
} as const;
/** Shared by the settings summary and the actual next-turn instructions. */
export function replyInstructions(reply: ReplyPreferences = defaultReply): string[] {
  return [
    reply.name ? `称呼我${reply.name}` : '',
    reply.language !== 'auto' ? `默认使用${replyOptions.language[reply.language]}` : '',
    reply.length !== 'auto' ? `回答${replyOptions.length[reply.length]}` : '',
    reply.tone !== 'auto' ? `语气${replyOptions.tone[reply.tone]}` : '',
  ].filter(Boolean);
}
export interface PreferenceCandidate extends PreferenceReference {
  content: string;
  subject: string;
  source: string;
  quotes: string[];
  occurredAt: number;
}
export interface PersonalizationState {
  profile: Personalization;
  defaultSoul: string;
  candidates: PreferenceCandidate[];
  unavailable: number;
}
