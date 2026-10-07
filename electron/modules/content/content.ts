import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../services/storage/store';
import type { Knowledge } from '../knowledge/knowledge';
import type { ToolScope } from '../../core/tools/extensions';
import type { ContentLibrary, ContentWrite, ContentState } from '../../../src/shared/content';
import type { KnowledgeDocument, KnowledgeSummary } from '../../../src/shared/knowledge';
import { knowledgeFolderForTool } from '../../../src/shared/knowledge';
import type { Session } from '../../../src/shared/types';
import { projectFamilyId } from '../../../src/shared/projects';

export const libraryIdSchema = z.union([z.literal('default'), z.string().uuid()]);
export const librarySchema = z.object({
  id: libraryIdSchema.optional(),
  version: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(80),
});
export const contentWriteSchema = z.object({
  id: z
    .string()
    .uuid()
    .optional()
    .describe('仅更新已有文档时提供查询到的真实 ID；新建必须省略，禁止占位 ID'),
  version: z.number().int().positive().optional().describe('仅更新时提供读到的当前版本；新建省略'),
  libraryId: libraryIdSchema,
  folderId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(180),
  content: z.string().max(200000),
  contentType: z.string().trim().max(80).optional(),
  sourceIds: z.array(z.string().uuid()).max(20).optional(),
});
export const contentRunSchema = z.object({
  documentId: z.string().uuid(),
  version: z.number().int().positive(),
  providerId: z.string().min(1).max(120),
  model: z.string().min(1).max(200),
  agentId: z.string().max(120).optional(),
  prompt: z.string().trim().min(1).max(16000),
  selection: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      text: z.string().max(16000),
    })
    .optional(),
});
const deriveSchema = z.object({
  sourceId: z.string().uuid(),
  version: z.number().int().positive(),
  folderId: z.string().uuid().nullable().optional(),
  mode: z.enum(['split', 'transform']),
  parts: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(180),
        content: z.string().max(200000).optional(),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().positive().optional(),
        contentType: z.string().max(80).optional(),
      }),
    )
    .min(1)
    .max(20),
});
const summarize = ({
  content,
  memoryEntries: _e,
  memoryCandidateIds: _c,
  assertions: _a,
  forgottenMemoryKeys: _f,
  ...doc
}: KnowledgeDocument): KnowledgeSummary => ({ ...doc, excerpt: content.slice(0, 200) });

export class ContentWorkspace {
  constructor(
    private store: Store,
    private knowledge: Knowledge,
  ) {}
  libraries(): ContentLibrary[] {
    const saved = this.store.list<ContentLibrary>('contentLibrary');
    return [
      { id: 'default', name: '我的内容', version: 1 },
      ...saved.filter((l) => l.id !== 'default'),
    ].map((l) => saved.find((s) => s.id === l.id) ?? l);
  }
  library(id: string) {
    libraryIdSchema.parse(id);
    const library = this.libraries().find((l) => l.id === id);
    if (!library) throw new Error('内容库不存在');
    return library;
  }
  saveLibrary(raw: unknown) {
    const p = librarySchema.parse(raw),
      old = p.id ? this.library(p.id) : undefined;
    if (old && old.version !== p.version) throw new Error('内容库已更新，请刷新后重试');
    if (
      this.libraries().some((l) => l.id !== p.id && l.name.toLowerCase() === p.name.toLowerCase())
    )
      throw new Error('已有同名内容库');
    if (!old && this.libraries().length >= 100) throw new Error('最多支持 100 个内容库');
    const next = { id: old?.id ?? randomUUID(), name: p.name, version: (old?.version ?? 0) + 1 };
    this.store.put('contentLibrary', next);
    return next;
  }
  deleteLibrary(id: string, version: number) {
    const old = this.library(id);
    if (id === 'default') throw new Error('默认内容库不能删除');
    if (old.version !== version) throw new Error('内容库已更新，请刷新后重试');
    if (
      this.knowledge.all().some((d) => d.libraryId === id) ||
      this.knowledge.folders().some((f) => f.libraryId === id)
    )
      throw new Error('请先移除库内文档和目录，再删除空内容库');
    this.store.remove('contentLibrary', id);
  }
  state(libraryId: string, query = '', sessionId?: string): ContentState {
    this.library(libraryId);
    const documents = this.knowledge
      .all()
      .filter(
        (d) =>
          d.kind !== 'memory' &&
          d.status !== 'archived' &&
          (d.libraryId ?? 'default') === libraryId &&
          (!sessionId || this.knowledge.accessible(d, sessionId)) &&
          `${d.title}\n${d.content}`.toLowerCase().includes(query.toLowerCase()),
      );
    return {
      libraries: this.libraries(),
      folders: this.knowledge.folders().filter((f) => (f.libraryId ?? 'default') === libraryId),
      documents: documents
        .sort((a, b) =>
          a.derivation && b.derivation && a.derivation.batchId === b.derivation.batchId
            ? a.derivation.index - b.derivation.index
            : (b.derivation?.createdAt ?? b.updatedAt) - (a.derivation?.createdAt ?? a.updatedAt),
        )
        .map(summarize),
    };
  }
  document(id: string, sessionId?: string) {
    const doc = this.knowledge.get(id);
    if (doc.kind === 'memory' || doc.status === 'archived') throw new Error('请选择可用的内容文档');
    if (sessionId && !this.knowledge.accessible(doc, sessionId))
      throw new Error('文档不在当前内容范围');
    return doc;
  }
  write(raw: ContentWrite, sessionId?: string, workspace = false) {
    const p = contentWriteSchema.parse(raw);
    this.library(p.libraryId);
    const session = sessionId ? this.store.get<Session>('session', sessionId) : undefined;
    if (session?.contentContext && session.contentContext.libraryId !== p.libraryId)
      throw new Error('不能写入其他内容库');
    if (p.id && !this.knowledge.all().some((d) => d.id === p.id))
      throw new Error(
        '更新目标文档不存在。新建请省略 id 和 version，由内容库生成真实 ID；更新请先查询真实文档 ID',
      );
    if (!p.id && p.version !== undefined) throw new Error('新建文档请同时省略 id 和 version');
    const old = p.id ? this.document(p.id, workspace ? undefined : sessionId) : undefined;
    if (old?.origin === 'import') throw new Error('原件保留不变，请另存为可编辑副本');
    for (const id of p.sourceIds ?? []) {
      const source = this.document(id, workspace ? undefined : sessionId);
      if ((source.libraryId ?? 'default') !== p.libraryId) throw new Error('来源必须在当前内容库');
      if (id === p.id) throw new Error('文档不能引用自身作为来源');
    }
    return this.knowledge.save(
      {
        ...p,
        kind: old?.kind ?? 'source',
        projectId: old
          ? old.projectId
          : projectFamilyId(this.store.list('project'), session?.projectId),
        tags: old?.tags ?? [],
        sourceIds: p.sourceIds ?? old?.sources.filter((s) => s.version).map((s) => s.id) ?? [],
        status: sessionId ? 'draft' : old?.status === 'draft' ? 'draft' : 'ready',
      },
      sessionId ? 'agent' : 'manual',
      {
        ...(old && p.sourceIds === undefined ? { sources: old.sources } : {}),
      },
    );
  }
  receipt(id: string) {
    // Read the committed document, not the model's submitted arguments.
    const doc = this.document(id);
    return {
      ...summarize(doc),
      persisted: true,
      totalChars: doc.content.length,
      sha256: createHash('sha256').update(doc.content).digest('hex'),
    };
  }
  derive(raw: unknown, sessionId: string) {
    const p = deriveSchema.parse(raw),
      source = this.document(p.sourceId, sessionId);
    if (source.version !== p.version) throw new Error('来源已更新，请重新读取后拆分或加工');
    if (
      p.folderId &&
      (this.knowledge.folders().find((f) => f.id === p.folderId)?.libraryId ?? 'default') !==
        (source.libraryId ?? 'default')
    )
      throw new Error('目标目录不属于当前内容库');
    if (p.folderId && !this.knowledge.folders().some((f) => f.id === p.folderId))
      throw new Error('目标目录不存在');
    let end = 0;
    const parts = p.parts.map((part) => {
      if (p.mode === 'split') {
        if (
          part.start !== end ||
          part.end === undefined ||
          part.end <= end ||
          part.end > source.content.length
        )
          throw new Error('拆分范围必须按顺序覆盖全文，不能遗漏或重叠');
        end = part.end;
        return { ...part, content: source.content.slice(part.start, part.end) };
      }
      if (part.content === undefined) throw new Error('加工结果必须提供正文');
      return { ...part, content: part.content };
    });
    if (p.mode === 'split' && end !== source.content.length) throw new Error('拆分范围未覆盖全文');
    if (parts.reduce((n, part) => n + part.content.length, 0) > 400000)
      throw new Error('单批结果最多 400,000 字符，请分批处理');
    // Durable per-part keys make an interrupted retry resume without duplicate documents.
    const batchId = createHash('sha256')
      .update(JSON.stringify([sessionId, p]))
      .digest('hex');
    const results: KnowledgeDocument[] = [];
    const batchTime =
      this.knowledge.all().find((d) => d.derivation?.batchId === batchId)?.derivation?.createdAt ??
      Date.now();
    for (let index = 0; index < parts.length; index++) {
      const key = `${batchId}:${index}`;
      const existing = this.knowledge
        .all()
        .find((d) => (d as KnowledgeDocument & { derivationKey?: string }).derivationKey === key);
      if (existing) {
        results.push(existing);
        continue;
      }
      const part = parts[index];
      results.push(
        this.knowledge.save(
          {
            title: part.title,
            content: part.content,
            contentType: part.contentType,
            kind: 'source',
            projectId: source.projectId,
            status: 'draft',
            libraryId: source.libraryId ?? 'default',
            folderId: p.folderId ?? source.folderId,
            sourceIds: [source.id],
          },
          'agent',
          {
            derivationKey: key,
            derivation: {
              batchId,
              index,
              createdAt: batchTime,
              sourceId: source.id,
              sourceVersion: source.version,
              mode: p.mode,
              ...(p.mode === 'split' ? { start: part.start, end: part.end } : {}),
            },
          },
        ),
      );
    }
    return results.map(summarize);
  }
  attach(
    scope: ToolScope,
    sessionId: string,
    readOnly: boolean,
    changed: () => void,
    used?: (id: string) => void,
  ) {
    const context = this.store.get<Session>('session', sessionId).contentContext;
    const add = (
      name: string,
      description: string,
      schema: z.ZodType,
      fn: (value: any) => unknown,
      writes = false,
    ) => {
      if (writes && readOnly) return;
      scope.add(
        { name, description, parameters: z.toJSONSchema(schema) },
        description,
        async (args) => {
          if (context) this.knowledge.assertUsable(context.documentId);
          const result = fn(schema.parse(args));
          if (writes) changed();
          return { text: JSON.stringify(result) };
        },
        false,
      );
    };
    const checkLibrary = (id: string) => {
      this.library(id);
      if (context && context.libraryId !== id) throw new Error('内容库不在当前范围');
    };
    add(
      'content_list',
      '普通会话也可列出内容库、目录及可访问文档摘要；正文需 content_read。所有目录及未分类文档默认可用，无需目录开关；仍遵循项目与会话范围。',
      z.object({
        libraryId: libraryIdSchema.optional(),
        query: z.string().max(500).optional(),
        offset: z.number().int().nonnegative().default(0),
      }),
      (p) => {
        const id = p.libraryId ?? context?.libraryId ?? 'default';
        checkLibrary(id);
        const state = this.state(id, p.query, sessionId);
        return {
          ...state,
          folders: state.folders.map((f) => knowledgeFolderForTool(f, state.folders)),
          libraries: context ? [this.library(id)] : state.libraries,
          documents: state.documents.slice(p.offset, p.offset + 30),
          nextOffset: p.offset + 30 < state.documents.length ? p.offset + 30 : null,
        };
      },
    );
    add(
      'content_read',
      '分段读取内容正文与当前版本；编辑前必须读取。',
      z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative().default(0) }),
      (p) => {
        const d = this.document(p.id, sessionId);
        used?.(d.id);
        return {
          ...summarize(d),
          content: d.content.slice(p.offset, p.offset + 12000),
          totalChars: d.content.length,
          nextOffset: p.offset + 12000 < d.content.length ? p.offset + 12000 : null,
        };
      },
    );
    add(
      'content_write',
      '按用户指定的 libraryId 和 folderId 直接创建或更新内容库文档，无需重复确认。新建时省略 id/version，更新必须携带真实 id 和当前 version。返回已持久化文档 ID、字符数和摘要，之后用 content_read 核验。不会覆盖导入原件。',
      contentWriteSchema,
      (p) => this.receipt(this.write(p, sessionId).id),
      true,
    );
    add(
      'content_patch',
      '精确替换文档中的唯一原文片段并保存版本；原文不唯一或版本变化时拒绝。',
      z.object({
        id: z.string().uuid(),
        version: z.number().int().positive(),
        before: z.string().min(1).max(40000),
        after: z.string().max(40000),
      }),
      (p) => {
        const d = this.document(p.id, sessionId);
        const first = d.content.indexOf(p.before);
        if (first < 0 || d.content.indexOf(p.before, first + 1) >= 0)
          throw new Error('原文片段不存在或不唯一，请重新读取并扩大定位范围');
        return summarize(
          this.write(
            {
              id: d.id,
              version: p.version,
              libraryId: d.libraryId ?? 'default',
              title: d.title,
              content:
                d.content.slice(0, first) + p.after + d.content.slice(first + p.before.length),
            },
            sessionId,
          ),
        );
      },
      true,
    );
    add(
      'content_derive',
      '拆分或加工来源文档为多份文档，保留来源版本。split 使用 UTF-16 字符偏移连续覆盖全文，不改写原文；transform 提供新正文。相同参数重试不会重复生成。',
      deriveSchema,
      (p) => this.derive(p, sessionId),
      true,
    );
    add(
      'content_folder',
      '在指定内容库新建目录，或按当前 version 重命名、移动目录。目录默认可用，无需开启开关；不能跨内容库移动。',
      z.object({
        libraryId: libraryIdSchema,
        id: z.string().uuid().optional(),
        version: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(60),
        parentId: z.string().uuid().nullable().optional(),
      }),
      (p) => {
        checkLibrary(p.libraryId);
        const folder = this.knowledge.saveFolder(p);
        return knowledgeFolderForTool(folder, this.knowledge.folders());
      },
      true,
    );
  }
}
