import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { writeLocalFile } from '../../services/storage/file-transfer';
import { CanvasTransfer, MAX_CANVAS_PACKAGE } from '../../modules/canvas/transfer';
import { dialog } from 'electron';
import type { Plugin } from 'cordis';
import { z } from 'zod';
import { manual } from '../../core/tools/client-commands';
import { canvasWriteSchema, executeSchema, resourceSchema } from '../../modules/canvas/canvas';
import { isUserSession } from '../../../src/shared/session-scope';
import type { Session } from '../../../src/shared/types';
import type { CanvasResource } from '../../../src/shared/canvas';
import '../context';

export const canvasPlugin: Plugin.Object<void> = {
  name: 'tongzhou-canvas',
  inject: [
    'tzIpc',
    'tzStore',
    'tzCanvases',
    'tzCanvasWorkflows',
    'tzEvents',
    'tzTasks',
    'tzContent',
    'tzKnowledge',
    'tzArtifacts',
    'tzChannels',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx),
      store = ctx.tzStore,
      canvases = ctx.tzCanvases,
      workflows = ctx.tzCanvasWorkflows;
    workflows.configureNotifications((target, text, session, key, signal) =>
      ctx.tzChannels.send(target, text, session, key, undefined, signal),
    );
    ctx.effect(() => () => workflows.configureNotifications());
    const define = (
      name: string,
      description: string,
      args: [z.ZodType, ...z.ZodType[]] | [],
      _write: boolean,
      fn: (...args: any[]) => any,
    ) =>
      register(
        name,
        manual(
          '画布',
          description,
          'canvas',
          '原生画布界面操作；会话请使用 canvas_list、canvas_read、canvas_apply、canvas_execute、canvas_cancel',
          args,
        ),
        fn,
      );
    const transfer = new CanvasTransfer(
      canvases,
      workflows.resources,
      ctx.tzContent,
      ctx.tzKnowledge,
      ctx.tzArtifacts,
    );
    const versionSchema = z.number().int().positive();
    const folder = (name: string) =>
      ctx.tzKnowledge
        .folders()
        .find((f) => (f.libraryId ?? 'default') === 'default' && !f.parentId && f.name === name) ??
      ctx.tzKnowledge.saveFolder({ name, libraryId: 'default' });
    define(
      'canvasExport',
      '导出工作流模板或含引用素材的项目 JSON',
      [z.uuid(), versionSchema, z.enum(['template', 'project'])],
      false,
      async (id, version, mode) => {
        const title = canvases.get(id).title.replace(/[<>:"/\\|?*]/g, '_');
        const result = await dialog.showSaveDialog({
          title: mode === 'project' ? '导出含素材的画布项目' : '导出工作流模板',
          defaultPath: title + (mode === 'project' ? '.canvas.json' : '.template.json'),
          filters: [{ name: '同舟画布', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return null;
        const original = await readFile(result.filePath).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return undefined;
          throw e;
        });
        const expected = original ? createHash('sha256').update(original).digest('hex') : undefined;
        const text = await transfer.encode(id, version, mode);
        await writeLocalFile(result.filePath, Buffer.from(text), expected);
        return result.filePath;
      },
    );
    define('canvasImport', '导入画布项目或模板到新画布', [], true, async () => {
      const result = await dialog.showOpenDialog({
        title: '导入画布',
        properties: ['openFile'],
        filters: [{ name: '同舟画布', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      if ((await stat(result.filePaths[0])).size > MAX_CANVAS_PACKAGE)
        throw new Error('画布项目包超过 96 MB');
      const next = await transfer.decode(await readFile(result.filePaths[0], 'utf8'));
      ctx.tzEvents.changed();
      return next;
    });
    define(
      'canvasSaveTemplate',
      '将可复用工作流保存到内容库',
      [z.uuid(), versionSchema],
      true,
      async (id, version) => {
        const text = await transfer.encode(id, version, 'template');
        ctx.tzContent.write({
          libraryId: 'default',
          folderId: folder('画布模板').id,
          title: canvases.get(id).title,
          content: text,
          contentType: 'canvas-template',
          tags: ['画布模板'],
        });
        ctx.tzEvents.changed();
      },
    );
    define(
      'canvasLoadTemplate',
      '从内容库模板创建画布',
      [z.uuid(), versionSchema],
      true,
      async (id, version) => {
        const doc = ctx.tzContent.document(id);
        if (doc.version !== version || doc.contentType !== 'canvas-template')
          throw new Error('模板已变化，请重新选择');
        const next = await transfer.decode(doc.content);
        ctx.tzEvents.changed();
        return next;
      },
    );
    define(
      'canvasLibrary',
      '读取内容库中的画布模板或提示词',
      [z.enum(['prompt', 'template'])],
      false,
      (mode) =>
        ctx.tzKnowledge
          .all()
          .filter(
            (d) =>
              d.kind !== 'memory' &&
              d.contentType === (mode === 'prompt' ? 'canvas-prompt' : 'canvas-template'),
          )
          .map(({ id, version, title, content, tags }) => ({
            id,
            version,
            title,
            content: mode === 'template' ? '' : content,
            tags,
          })),
    );
    define(
      'canvasSavePrompt',
      '保存带标签和变量的提示词到内容库',
      [
        z
          .object({
            id: z.uuid().optional(),
            version: versionSchema.optional(),
            title: z.string().trim().min(1).max(180),
            content: z.string().min(1).max(32000),
            tags: z.array(z.string().trim().min(1).max(40)).max(20),
          })
          .strict(),
      ],
      true,
      (input) => {
        const old = input.id ? ctx.tzContent.document(input.id) : undefined;
        if (old && old.contentType !== 'canvas-prompt') throw new Error('请选择提示词文档');
        ctx.tzContent.write({
          ...input,
          libraryId: old?.libraryId ?? 'default',
          folderId: old?.folderId ?? folder('画布提示词').id,
          contentType: 'canvas-prompt',
        });
        ctx.tzEvents.changed();
      },
    );
    define('canvasChooseOutputDirectory', '选择生成结果的本地保存目录', [], true, async () => {
      const result = await dialog.showOpenDialog({
        title: '选择生成结果保存目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    define('canvasState', '读取通用画布及其独立执行记录', [z.uuid().optional()], false, (id) =>
      canvases.state(id),
    );
    define(
      'canvasSave',
      '保存画布完整定义；更新必须提供当前版本',
      [canvasWriteSchema],
      true,
      (raw) => {
        const c = canvases.save(raw);
        ctx.tzEvents.changed();
        return c;
      },
    );
    define(
      'canvasDelete',
      '删除画布，保留执行历史',
      [z.uuid(), z.number().int().positive()],
      true,
      (id, v) => {
        canvases.delete(id, v);
        ctx.tzEvents.changed();
      },
    );
    define(
      'canvasBind',
      '将画布关联到会话并设为当前操作目标',
      [z.uuid(), z.uuid().nullable()],
      true,
      (s, id) => {
        canvases.bind(s, id);
        ctx.tzEvents.changed();
      },
    );
    define(
      'canvasExecute',
      '执行保存的工作流；节点及依赖按顺序运行，版本固定',
      [executeSchema],
      true,
      (p) => workflows.start(p),
    );
    define('canvasCancel', '停止工作流，保留已经完成的结果', [z.uuid()], true, (id) =>
      workflows.cancel(id),
    );
    define('canvasResourcePreview', '预览画布引用的原件', [resourceSchema], false, (r) =>
      workflows.resources.preview(r),
    );
    // Selection is native UI only: chat uses its scoped source tools and canvas_apply.
    define(
      'canvasSources',
      '搜索可放入画布的内容、作品或会话消息',
      [
        z
          .object({
            kind: z.enum(['content', 'artifact', 'message']),
            media: z.enum(['image', 'video', 'audio']).optional(),
            query: z.string().max(200).optional(),
            sessionId: z.uuid().optional(),
          })
          .strict(),
      ],
      false,
      (raw) => {
        const p = z
          .object({
            kind: z.enum(['content', 'artifact', 'message']),
            media: z.enum(['image', 'video', 'audio']).optional(),
            query: z.string().max(200).default(''),
            sessionId: z.uuid().optional(),
          })
          .parse(raw);
        const matches = (title: string) => title.toLowerCase().includes(p.query.toLowerCase());
        const choices: { title: string; resource: CanvasResource }[] =
          p.kind === 'content'
            ? ctx.tzKnowledge
                .all()
                .filter(
                  (d) =>
                    d.kind !== 'memory' &&
                    matches(d.title) &&
                    (!p.media ||
                      (p.media === 'audio'
                        ? /\.(mp3|wav|m4a|ogg|flac)$/i
                        : p.media === 'image'
                          ? /\.(png|jpe?g|webp)$/i
                          : /\.(mp4|webm)$/i
                      ).test(d.fileName ?? '')),
                )
                .slice(0, 150)
                .map((d) => ({
                  title: d.title,
                  resource: { kind: 'content', id: d.id, version: d.version },
                }))
            : p.kind === 'artifact'
              ? ctx.tzArtifacts
                  .list({ query: p.query, kind: p.media })
                  .items.map((a) => ({ title: a.name, resource: { kind: 'artifact', id: a.id } }))
              : p.sessionId
                ? store
                    .messages(p.sessionId)
                    .filter(
                      (m) =>
                        ['user', 'assistant'].includes(m.role) &&
                        m.status !== 'streaming' &&
                        matches(m.content),
                    )
                    .slice(-100)
                    .map((m) => ({
                      title: m.content.slice(0, 100),
                      resource: { kind: 'message' as const, id: m.id, sessionId: m.sessionId },
                    }))
                : [];
        return {
          choices,
          sessions: store
            .list<Session>('session')
            .filter((s) => isUserSession(s) && !s.archived)
            .map(({ id, title }) => ({ id, title })),
        };
      },
    );
  },
};
