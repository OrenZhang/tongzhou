import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  entityTypes,
  relationTypes,
  type KnowledgeAssertion,
  type KnowledgeEntity,
  type KnowledgeFact,
  type KnowledgeGraph,
} from '../../../src/shared/ontology';
import type { KnowledgeDocument } from '../../../src/shared/knowledge';

const entityType = z.enum(
  Object.keys(entityTypes) as [keyof typeof entityTypes, ...(keyof typeof entityTypes)[]],
);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
export const assertionInput = z
  .object({
    subject: z.string().trim().min(1).max(120),
    subjectType: entityType,
    relation: z.enum(
      Object.keys(relationTypes) as [keyof typeof relationTypes, ...(keyof typeof relationTypes)[]],
    ),
    object: z.string().trim().min(1).max(1000),
    objectType: entityType.optional(),
    sourceId: z.string().uuid().optional(),
    quote: z.string().trim().min(1).max(2000),
    validFrom: date.optional(),
    validUntil: date.optional(),
  })
  .superRefine((a, ctx) => {
    if (relationTypes[a.relation].entity !== !!a.objectType)
      ctx.addIssue({
        code: 'custom',
        message: '实体关系必须指定目标类型，文字属性不能指定目标类型',
      });
    if (a.relation === 'owner' && a.objectType !== 'person' && a.objectType !== 'organization')
      ctx.addIssue({ code: 'custom', message: '负责人必须是人物或组织' });
    if (a.validFrom && a.validUntil && a.validFrom > a.validUntil)
      ctx.addIssue({ code: 'custom', message: '有效截止日期不能早于开始日期' });
  });
const norm = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const key = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

/** A rebuildable projection of versioned documents; never a second editable source of truth. */
export function buildKnowledgeGraph(
  docs: KnowledgeDocument[],
  staleIds: Set<string>,
  query = '',
  offset = 0,
  limit = 100,
): KnowledgeGraph {
  const entities = new Map<string, KnowledgeEntity>();
  const facts = new Map<string, KnowledgeFact>();
  const entity = (name: string, type: KnowledgeAssertion['subjectType'], scope: string) => {
    const id = key(scope, type, norm(name));
    if (!entities.has(id)) entities.set(id, { id, name, type, scope });
    return id;
  };
  const add = (
    doc: KnowledgeDocument,
    a: KnowledgeAssertion,
    scope: string,
    reviewed: boolean,
    extra: Partial<KnowledgeFact['evidence'][number]>,
  ) => {
    const subjectId = entity(a.subject, a.subjectType, scope);
    const objectId = a.objectType ? entity(a.object, a.objectType, scope) : undefined;
    // Text values are case-sensitive: commands and URLs can differ by case.
    const id = key(
      subjectId,
      a.relation,
      objectId ?? a.object.trim(),
      a.validFrom ?? '',
      a.validUntil ?? '',
    );
    const stale = staleIds.has(doc.id) || (!!a.sourceId && staleIds.has(a.sourceId));
    const fact = facts.get(id) ?? {
      id,
      subjectId,
      objectId,
      subject: a.subject,
      relation: a.relation,
      object: a.object,
      scope,
      validFrom: a.validFrom,
      validUntil: a.validUntil,
      status: 'pending',
      conflict: false,
      evidence: [],
    };
    fact.evidence.push({
      documentId: doc.id,
      title: doc.title,
      version: doc.version,
      quote: a.quote,
      sourceId: a.sourceId,
      reviewed,
      stale,
      ...extra,
    });
    facts.set(id, fact);
  };
  for (const doc of docs) {
    const scope = doc.projectId
      ? `project:${doc.projectId}`
      : doc.sessionId && !(doc.kind === 'wiki' && doc.status === 'ready')
        ? `session:${doc.sessionId}`
        : 'global';
    doc.assertions?.forEach((a, i) =>
      add(doc, a, scope, doc.status === 'ready', { assertionIndex: i }),
    );
    doc.memoryEntries?.forEach((e) =>
      add(
        doc,
        {
          subject: e.subject || '会话经验',
          subjectType: 'concept',
          relation: e.category,
          object: e.content,
          quote:
            e.quotes?.join('\n') ||
            `历史记忆摘要（未保存逐字引文）：${e.subject} ${e.relation} ${e.content}`,
        },
        e.projectId ? `project:${e.projectId}` : `session:${e.sessionId}`,
        !!e.reviewedAt,
        { entryId: e.id },
      ),
    );
  }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const f of facts.values()) {
    f.status =
      f.validUntil && f.validUntil < today
        ? 'expired'
        : f.evidence.every((e) => e.stale)
          ? 'stale'
          : f.evidence.some((e) => e.reviewed && !e.stale)
            ? 'confirmed'
            : 'pending';
    if (f.relation === 'conflict') f.conflict = true;
  }
  const grouped = new Map<string, KnowledgeFact[]>();
  for (const f of facts.values())
    if (relationTypes[f.relation].single && f.status !== 'expired' && f.status !== 'stale') {
      const group = `${f.subjectId}:${f.relation}`;
      for (const other of grouped.get(group) ?? []) {
        if (
          other.object !== f.object &&
          (f.validFrom ?? '') <= (other.validUntil ?? '9999-12-31') &&
          (other.validFrom ?? '') <= (f.validUntil ?? '9999-12-31')
        )
          other.conflict = f.conflict = true;
      }
      grouped.set(group, [...(grouped.get(group) ?? []), f]);
    }
  const q = norm(query);
  const matches = [...facts.values()].filter(
    (f) =>
      !q ||
      norm(
        `${f.subject} ${f.object} ${relationTypes[f.relation].label} ${f.evidence.map((e) => e.title).join(' ')}`,
      ).includes(q),
  );
  matches.sort(
    (a, b) =>
      Number(b.conflict) - Number(a.conflict) ||
      a.subject.localeCompare(b.subject, 'zh-CN') ||
      a.id.localeCompare(b.id),
  );
  const page = matches.slice(offset, offset + limit);
  const ids = new Set(page.flatMap((f) => [f.subjectId, f.objectId]));
  return {
    entities: [...entities.values()].filter((e) => ids.has(e.id)),
    facts: page,
    total: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
  };
}
