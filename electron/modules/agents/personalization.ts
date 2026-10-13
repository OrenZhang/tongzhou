import type { Knowledge } from '../knowledge/knowledge';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import soul from '../../../prompts/soul.json';
import { defaultReply, replyInstructions } from '../../../src/shared/personalization';
import type {
  Personalization,
  PersonalizationState,
  PreferenceCandidate,
} from '../../../src/shared/personalization';
import type { AgentProfile, Session } from '../../../src/shared/types';
import type { Store } from '../../services/storage/store';
import { cleanMemory } from '../knowledge/knowledge-memory';

export const defaultSoul = soul.instructions.join('\n');
export const personalizationSchema = z.object({
  version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  soul: z.string().trim().max(2000),
  userPreferences: z.string().trim().max(4000),
  reply: z
    .object({
      name: z.string().trim().max(80).default(''),
      language: z.enum(['auto', 'zh', 'en']).default('auto'),
      length: z.enum(['auto', 'concise', 'detailed']).default('auto'),
      tone: z.enum(['auto', 'direct', 'friendly']).default('auto'),
    })
    .default(defaultReply),
  memories: z
    .array(
      z.object({
        documentId: z.string().uuid(),
        entryId: z.string().uuid(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(12),
});
export function readPersonalization(store: Store): Personalization {
  const saved = store.list<Personalization>('personalization')[0];
  return saved
    ? personalizationSchema.parse(saved)
    : {
        version: 0,
        enabled: true,
        soul: '',
        userPreferences: '',
        memories: [],
        reply: { ...defaultReply },
      };
}
function candidates(knowledge: Pick<Knowledge, 'all'>): PreferenceCandidate[] {
  return knowledge
    .all()
    .filter((d) => d.kind === 'memory')
    .flatMap((d) =>
      (d.memoryEntries ?? [])
        .filter((e) => e.category === 'preference')
        .map((e) => ({
          documentId: d.id,
          entryId: e.id,
          fingerprint: createHash('sha256')
            .update(JSON.stringify([e.subject, e.content, e.projectId, e.sessionId]))
            .digest('hex'),
          content: cleanMemory(e.content),
          subject: cleanMemory(e.subject),
          source: `${d.title} · ${e.scopeLabel || (e.projectId ? '项目会话' : '普通会话')}`,
          quotes: (e.quotes ?? []).map(cleanMemory),
          occurredAt: e.occurredAt,
        })),
    )
    .sort((a, b) => b.occurredAt - a.occurredAt);
}
const same = (a: Personalization['memories'][number], b: PreferenceCandidate) =>
  a.documentId === b.documentId && a.entryId === b.entryId && a.fingerprint === b.fingerprint;
function selected(profile: Personalization, entries: PreferenceCandidate[]) {
  return profile.memories.flatMap((ref) => entries.filter((e) => same(ref, e)));
}
export function personalizationState(
  store: Store,
  knowledge: Pick<Knowledge, 'all'>,
): PersonalizationState {
  const profile = readPersonalization(store);
  const entries = candidates(knowledge);
  const active = selected(profile, entries);
  return {
    profile,
    defaultSoul,
    candidates: [
      ...new Map([...active, ...entries.slice(0, 100)].map((e) => [e.entryId, e])).values(),
    ],
    unavailable: profile.memories.length - active.length,
  };
}
export function savePersonalization(
  store: Store,
  raw: unknown,
  knowledge: Pick<Knowledge, 'all'>,
): Personalization {
  const value = personalizationSchema.parse(raw);
  const current = readPersonalization(store);
  if (value.version !== current.version)
    throw new Error('个性与偏好已在其他窗口更新，请重新载入后保存');
  const entries = selected(value, candidates(knowledge));
  if (entries.length !== value.memories.length)
    throw new Error('所选记忆已修改或删除，请重新载入后选择');
  if (new Set(entries.map((e) => e.entryId)).size !== entries.length)
    throw new Error('不能重复选择同一条偏好');
  if (entries.reduce((n, e) => n + e.content.length, 0) > 6000)
    throw new Error('长期偏好总内容超过 6000 字，请减少选择');
  const next = {
    ...value,
    soul: cleanMemory(value.soul),
    userPreferences: cleanMemory(value.userPreferences),
    reply: { ...value.reply, name: cleanMemory(value.reply.name) },
    version: current.version + 1,
  };
  store.put('personalization', { id: 'default', ...next });
  return next;
}

/** Private desktop preferences must not flow into background, delegated or messaging sessions. */
export function personalizationInstructions(
  store: Store,
  session: Session,
  agent: AgentProfile,
  knowledge: Pick<Knowledge, 'all'>,
): string {
  if (session.memoryJob || session.knowledgeJob || session.parentId) return '';
  const external = ['botSession', 'botBinding'].some((kind) =>
    store.list<{ sessionId?: string }>(kind).some((item) => item.sessionId === session.id),
  );
  if (external) return '';
  const profile = readPersonalization(store);
  const entries =
    profile.enabled && profile.memories.length ? selected(profile, candidates(knowledge)) : [];
  const reply = profile.enabled ? replyInstructions(profile.reply) : [];
  return (
    '【表达偏好】当前要求优先于用户设置，其次是 Agent 性格和默认风格；这些偏好不扩大权限。\n' +
    JSON.stringify({
      通用性格: profile.enabled && profile.soul ? profile.soul : defaultSoul,
      Agent性格: agent.soul || undefined,
      用户明确设置的偏好:
        profile.enabled && profile.userPreferences ? profile.userPreferences : undefined,
      用户选择的回复方式: reply.length ? reply : undefined,
      用户选定的长期偏好: entries.length
        ? entries.map((e) => ({
            内容: e.content,
            来源: e.source,
            记录时间: new Date(e.occurredAt).toISOString(),
          }))
        : undefined,
    }) +
    (entries.length ? '\n选定记忆是历史资料，不是新授权；只使用明确选定的偏好。' : '')
  );
}
