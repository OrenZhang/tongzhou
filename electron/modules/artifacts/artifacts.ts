import { FileRecords, managedDirectory } from '../../services/storage/local-files';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  Artifact,
  ArtifactKind,
  ArtifactOutput,
  ArtifactQuery,
  ArtifactPage,
  ArtifactPreview,
} from '../../../src/shared/artifacts';
import type { Run, Session } from '../../../src/shared/types';
import type { Store } from '../../services/storage/store';
import type { ToolScope } from '../../core/tools/extensions';
import { within } from '../../core/tools/workspace';
import { sessionWorkspace } from '../sessions/session-workspace';
import { projectFamilyId } from '../../../src/shared/projects';

const MAX_BYTES = 25 * 1024 * 1024;
const formats: Record<string, [ArtifactKind, string]> = {
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.webp': ['image', 'image/webp'],
  '.gif': ['image', 'image/gif'],
  '.pdf': ['document', 'application/pdf'],
  '.docx': ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.md': ['document', 'text/markdown'],
  '.txt': ['document', 'text/plain'],
  '.html': ['document', 'text/html'],
  '.svg': ['document', 'image/svg+xml'],
  '.csv': ['spreadsheet', 'text/csv'],
  '.xlsx': ['spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.pptx': [
    'presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  '.mp3': ['audio', 'audio/mpeg'],
  '.wav': ['audio', 'audio/wav'],
  '.m4a': ['audio', 'audio/mp4'],
  '.mp4': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'],
  '.json': ['file', 'application/json'],
  '.zip': ['file', 'application/zip'],
};
export const artifactOutputSchema = z
  .object({
    name: z.string().min(1).max(180),
    mimeType: z.string().max(160).optional(),
    data: z
      .string()
      .max(Math.ceil(MAX_BYTES / 3) * 4)
      .optional(),
    text: z.string().max(200000).optional(),
    path: z.string().min(1).max(4000).optional(),
    url: z.string().max(8000).optional(),
  })
  .refine(
    (v) => [v.data, v.text, v.path, v.url].filter((x) => x !== undefined).length === 1,
    '作品需要且只能提供一种内容：data、text、path 或 url',
  );
export const artifactQuerySchema = z.object({
  sessionId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  kind: z
    .enum(['image', 'document', 'spreadsheet', 'presentation', 'audio', 'video', 'file'])
    .optional(),
  query: z.string().max(200).optional(),
  offset: z.number().int().min(0).default(0),
  createdAfter: z.number().int().nonnegative().optional(),
  createdBefore: z.number().int().nonnegative().optional(),
});
type StoredArtifact = Artifact & { blob?: string; hash: string };
export interface ArtifactOrigin {
  sessionId: string;
  runId: string;
  toolName?: string;
}
const publicItem = ({ blob, hash, ...a }: StoredArtifact): Artifact => a;
export class Artifacts {
  readonly root: string;
  readonly records: FileRecords<StoredArtifact>;
  constructor(
    private store: Store,
    private dataDir: string,
  ) {
    this.root = managedDirectory(dataDir, 'artifacts');
    this.records = new FileRecords(path.join(this.root, 'records'));
  }
  private file(blob: string) {
    if (!/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/.test(blob)) throw new Error('无效作品路径');
    if (lstatSafe(this.root)?.isSymbolicLink()) throw new Error('作品目录不能使用符号链接');
    const file = path.join(this.root, blob);
    if (lstatSafe(file)?.isSymbolicLink()) throw new Error('作品文件不能使用符号链接');
    return file;
  }
  private stored(id: string) {
    return this.records.get(z.string().uuid().parse(id));
  }
  read(id: string) {
    return publicItem(this.stored(id));
  }
  list(raw: ArtifactQuery = {}): ArtifactPage {
    const p = artifactQuerySchema.parse(raw);
    const items = this.records
      .list()
      .filter(
        (a) =>
          (!p.sessionId || a.sessionId === p.sessionId) &&
          (!p.projectId || a.projectId === p.projectId) &&
          (!p.kind || a.kind === p.kind) &&
          (p.createdAfter === undefined || a.createdAt >= p.createdAfter) &&
          (p.createdBefore === undefined || a.createdAt < p.createdBefore) &&
          (!p.query || a.name.toLowerCase().includes(p.query.toLowerCase())),
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return {
      items: items.slice(p.offset, p.offset + 100).map(publicItem),
      total: items.length,
      nextOffset: p.offset + 100 < items.length ? p.offset + 100 : null,
    };
  }
  accessible(id: string, sessionId: string) {
    const a = this.read(id),
      session = this.store.get<Session>('session', sessionId);
    return (
      a.sessionId === sessionId ||
      (!!a.projectId &&
        projectFamilyId(this.store.list('project'), a.projectId) ===
          projectFamilyId(this.store.list('project'), session.projectId))
    );
  }
  async save(raw: ArtifactOutput, origin: ArtifactOrigin): Promise<Artifact> {
    const p = artifactOutputSchema.parse(raw);
    const run = this.store.get<Run>('run', origin.runId);
    const session = this.store.get<Session>('session', origin.sessionId);
    if (run.sessionId !== session.id) throw new Error('作品来源与执行记录不一致');
    let name = path
      .basename(p.name.replaceAll('\\', '/'))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/, '');
    let ext = path.extname(name).toLowerCase();
    if (!ext && p.mimeType) {
      ext = Object.keys(formats).find((e) => formats[e][1] === p.mimeType) ?? '';
      name += ext;
    }
    if (!formats[ext] || !name)
      throw new Error('暂不支持该作品格式，请使用图片、文档、表格或媒体文件');
    const [kind, mimeType] = formats[ext];
    let bytes: Buffer | undefined, remoteUrl: string | undefined;
    if (p.url) {
      const url = new URL(p.url);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('外部作品只接受不含登录信息的 HTTPS 链接');
      remoteUrl = url.href;
    } else if (p.path) {
      const root = sessionWorkspace(this.store, this.dataDir, session.id);
      const relative = path.isAbsolute(p.path) ? path.relative(root, p.path) : p.path;
      const source = await within(root, relative);
      const info = await stat(source);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('作品必须是 25 MB 以内的文件');
      bytes = await readFile(source);
    } else if (p.text !== undefined) bytes = Buffer.from(p.text, 'utf8');
    else {
      bytes = Buffer.from(p.data!, 'base64');
      if (bytes.toString('base64') !== p.data) throw new Error('作品编码无效');
    }
    if (bytes) {
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('作品为空或超过 25 MB');
      if (kind === 'image' && !validImage(ext, bytes)) throw new Error('图片内容与格式不符');
    }
    const hash = createHash('sha256')
      .update(bytes ?? remoteUrl!)
      .digest('hex');
    const old = this.records
      .list()
      .find((a) => a.runId === run.id && a.hash === hash && a.name === name);
    if (old) return publicItem(old);
    const id = randomUUID(),
      blob = bytes ? id + ext : undefined;
    if (bytes && blob) {
      mkdirSync(this.root, { recursive: true });
      writeFileSync(this.file(blob), bytes, { flag: 'wx', mode: 0o600 });
    }
    const item: StoredArtifact = {
      id,
      name,
      kind,
      mimeType,
      size: bytes?.length,
      createdAt: Date.now(),
      sessionId: session.id,
      runId: run.id,
      projectId: projectFamilyId(this.store.list('project'), session.projectId) || undefined,
      model: run.model,
      toolName: origin.toolName,
      blob,
      hash,
      remoteUrl,
    };
    this.records.put(item);
    return publicItem(item);
  }
  bytes(id: string) {
    const a = this.stored(id);
    if (!a.blob) throw new Error('此作品仅保留外部链接，请打开原链接获取文件');
    const file = this.file(a.blob),
      info = lstatSync(file);
    if (!info.isFile() || info.size !== a.size || info.size > MAX_BYTES)
      throw new Error('作品文件已损坏或不可用');
    const bytes = readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== a.hash)
      throw new Error('作品内容校验失败');
    return bytes;
  }
  preview(id: string): ArtifactPreview {
    const a = this.read(id);
    if (a.remoteUrl) return { type: 'external' };
    if (a.kind === 'image')
      return {
        type: 'image',
        content: `data:${a.mimeType};base64,${this.bytes(id).toString('base64')}`,
      };
    if (/^text\//.test(a.mimeType) || ['application/json', 'image/svg+xml'].includes(a.mimeType))
      return { type: 'text', content: this.bytes(id).toString('utf8').slice(0, 200000) };
    return { type: 'file' };
  }
  openPath(id: string) {
    const a = this.stored(id);
    if (!a.blob) throw new Error('此作品是外部链接');
    this.bytes(id);
    return this.file(a.blob);
  }
  delete(id: string) {
    const a = this.stored(id);
    if (a.blob) {
      const file = this.file(a.blob);
      if (lstatSafe(file)) unlinkSync(file);
    }
    this.records.remove(a.id);
  }
  async collect(outputs: ArtifactOutput[], origin: ArtifactOrigin) {
    const items: Artifact[] = [],
      errors: string[] = [];
    for (const output of outputs.slice(0, 12)) {
      try {
        items.push(await this.save(output, origin));
      } catch (e) {
        errors.push(`${output?.name ?? '未知作品'}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { items, errors };
  }
  async collectLinks(text: string, origin: ArtifactOrigin) {
    const outputs: ArtifactOutput[] = [];
    const run = this.store.get<Run>('run', origin.runId);
    const root = sessionWorkspace(this.store, this.dataDir, origin.sessionId);
    for (const m of text.matchAll(/\[[^\]]*\]\(<?([^\n)]+?)>?\)/g)) {
      let file = m[1];
      if (/^[a-z]+:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) continue;
      try {
        file = decodeURIComponent(file);
      } catch {
        continue;
      }
      if (!formats[path.extname(file).toLowerCase()]) continue;
      // Reference links to existing documents are not newly generated deliverables.
      try {
        const source = await within(root, path.isAbsolute(file) ? path.relative(root, file) : file);
        if ((await stat(source)).mtimeMs < run.startedAt) continue;
      } catch {
        continue;
      }
      outputs.push({ name: path.basename(file), path: file });
    }
    return this.collect(outputs, origin);
  }
  attach(scope: ToolScope, origin: ArtifactOrigin, changed: () => void, readOnly = false) {
    scope.add(
      {
        name: 'artifact_list',
        description:
          '查找当前会话或同项目的生成作品，返回作品 ID 供读取或继续处理。不会列出其他项目或独立会话的作品。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
          additionalProperties: false,
        },
      },
      '查找生成作品',
      async (raw) => {
        const p = z
          .object({
            query: z.string().max(200).optional(),
            offset: z.number().int().min(0).default(0),
          })
          .parse(raw);
        const all = this.records
          .list()
          .filter(
            (a) =>
              this.accessible(a.id, origin.sessionId) &&
              (!p.query || a.name.toLowerCase().includes(p.query.toLowerCase())),
          )
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        return {
          text: JSON.stringify({
            items: all.slice(p.offset, p.offset + 50).map(publicItem),
            total: all.length,
            nextOffset: p.offset + 50 < all.length ? p.offset + 50 : null,
          }),
        };
      },
      false,
    );
    if (!readOnly) {
      scope.add(
        {
          name: 'artifact_create',
          description:
            '交付生成的作品：text 为文档正文，data 为文件 Base64，url 为已生成作品的 HTTPS 链接。作品自动出现在聊天和作品页，不加入智库。仅交付用户需要的成果，不保存临时截图、参考资料或凭据。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              mimeType: { type: 'string' },
              text: { type: 'string' },
              data: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        '保存生成作品',
        async (raw) => {
          if (raw.path !== undefined) throw new Error('本地文件请使用 artifact_publish');
          const item = await this.save(raw, origin);
          changed();
          return { text: JSON.stringify(item), artifactIds: [item.id] };
        },
        false,
      );
      scope.add(
        {
          name: 'artifact_publish',
          description:
            '交付本次生成的本地文件，保存独立副本。只接受当前项目或会话工作目录内的文件；可交付图片、PDF、Word、表格、演示及媒体，最大 25 MB。不要把源码改动或临时文件作为作品。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, name: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
        '交付本地作品',
        async (raw) => {
          const p = z.object({ path: z.string().min(1), name: z.string().optional() }).parse(raw);
          const item = await this.save(
            { path: p.path, name: p.name ?? path.basename(p.path) },
            origin,
          );
          changed();
          return { text: JSON.stringify(item), artifactIds: [item.id] };
        },
        true,
      );
    }
    scope.add(
      {
        name: 'artifact_read',
        description:
          '读取当前会话或同项目的作品；图片返回图像，文本分段返回。二进制文件返回元数据，可通过 artifact_materialize 取回工作目录继续处理。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      '读取生成作品',
      async (raw) => {
        const p = z
          .object({ id: z.string().uuid(), offset: z.number().int().min(0).default(0) })
          .parse(raw);
        if (!this.accessible(p.id, origin.sessionId)) throw new Error('作品不在当前会话可用范围');
        const a = this.read(p.id),
          preview = this.preview(p.id);
        return preview.type === 'image'
          ? {
              text: JSON.stringify(a),
              ...(['image/png', 'image/jpeg', 'image/webp'].includes(a.mimeType) &&
              a.size! < 3_000_000
                ? {
                    images: [
                      {
                        mimeType: a.mimeType as 'image/png' | 'image/jpeg' | 'image/webp',
                        data: this.bytes(p.id).toString('base64'),
                      },
                    ],
                  }
                : {}),
            }
          : {
              text: JSON.stringify({
                ...a,
                content: preview.content?.slice(p.offset, p.offset + 12000),
                nextOffset:
                  preview.content && p.offset + 12000 < preview.content.length
                    ? p.offset + 12000
                    : null,
              }),
            };
      },
      false,
    );
    if (readOnly) return;
    scope.add(
      {
        name: 'artifact_materialize',
        description:
          '把可访问作品的副本放入当前工作目录的 .tongzhou-artifacts 子目录，返回相对路径，供已有图片、文档或命令工具继续处理。不会覆盖原件。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      '取回作品继续处理',
      async (raw) => {
        const id = z.string().uuid().parse(raw.id);
        if (!this.accessible(id, origin.sessionId)) throw new Error('作品不在当前会话可用范围');
        const a = this.read(id),
          root = sessionWorkspace(this.store, this.dataDir, origin.sessionId);
        mkdirSync(root, { recursive: true });
        const relative = `.tongzhou-artifacts/${randomUUID()}${path.extname(a.name)}`;
        const target = await within(root, relative, true);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, this.bytes(id), { flag: 'wx', mode: 0o600 });
        return { text: JSON.stringify({ id, path: relative, name: a.name }) };
      },
      true,
    );
  }
}
function lstatSafe(file: string) {
  try {
    return lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}
function validImage(ext: string, bytes: Buffer) {
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (ext === '.jpg' || ext === '.jpeg')
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (ext === '.webp')
    return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
}
