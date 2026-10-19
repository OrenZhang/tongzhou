import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { writeLocalFile, absolutePathSchema } from '../../services/storage/file-transfer';
import {
  canvasMediaExtensions,
  importCanvasResources,
} from '../../modules/canvas/import-resources';
import { CanvasTransfer, MAX_CANVAS_PACKAGE } from '../../modules/canvas/transfer';
import { whiteboardSceneSchema } from '../../modules/canvas/whiteboard';
import { fetchCanvasText } from '../../modules/canvas/text-source';
import { basename } from 'node:path';
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
    define('whiteboardImport', '导入 Excalidraw 文件到新白板', [], true, async () => {
      const result = await dialog.showOpenDialog({
        title: '导入白板',
        properties: ['openFile'],
        filters: [{ name: 'Excalidraw', extensions: ['excalidraw', 'json'] }],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) return null;
      if ((await stat(path)).size > MAX_CANVAS_PACKAGE) throw new Error('白板内容超过 96 MB');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.type !== 'excalidraw') throw new Error('请选择 Excalidraw 白板文件');
      const whiteboard = whiteboardSceneSchema.parse({
        elements: value.elements,
        files: value.files ?? {},
        appState: value.appState ?? {},
        ...(value.libraryItems ? { libraryItems: value.libraryItems } : {}),
      });
      const next = canvases.save({
        title:
          basename(path)
            .replace(/\.(excalidraw|json)$/i, '')
            .slice(0, 180) || '白板',
        mode: 'whiteboard',
        whiteboard,
        nodes: [],
        edges: [],
        selection: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      ctx.tzEvents.changed();
      return next;
    });
    define(
      'whiteboardExport',
      '导出白板文件或图片',
      [
        z
          .object({
            title: z.string().max(180),
            format: z.enum(['excalidraw', 'svg', 'png']),
            data: z.string().max(128 * 1024 * 1024),
          })
          .strict(),
      ],
      false,
      async (input) => {
        const { title, format, data } = input;
        if (format === 'png' && !/^data:image\/png;base64,/.test(data))
          throw new Error('PNG 格式无效');
        if (format === 'excalidraw') {
          const value = JSON.parse(data);
          if (value.type !== 'excalidraw') throw new Error('白板格式无效');
          whiteboardSceneSchema.parse({
            elements: value.elements,
            files: value.files ?? {},
            appState: value.appState ?? {},
            ...(value.libraryItems ? { libraryItems: value.libraryItems } : {}),
          });
        }
        const result = await dialog.showSaveDialog({
          title: '导出白板',
          defaultPath: title.replace(/[<>:"/\\|?*]/g, '_') + '.' + format,
          filters: [{ name: format, extensions: [format] }],
        });
        if (result.canceled || !result.filePath) return null;
        const original = await readFile(result.filePath).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return undefined;
          throw e;
        });
        await writeLocalFile(
          result.filePath,
          format === 'png' ? Buffer.from(data.split(',')[1], 'base64') : Buffer.from(data),
          original ? createHash('sha256').update(original).digest('hex') : undefined,
        );
        return result.filePath;
      },
    );
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
          filters: [{ name: 'CoSail画布', extensions: ['json'] }],
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
        filters: [{ name: 'CoSail画布', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      if ((await stat(result.filePaths[0])).size > MAX_CANVAS_PACKAGE)
        throw new Error('画布项目包超过 96 MB');
      const text = await readFile(result.filePaths[0], 'utf8');
      const next =
        JSON.parse(text).format === 'tongzhou-canvas'
          ? await transfer.decode(text)
          : await workflows.comfy.import(text);
      ctx.tzEvents.changed();
      return next;
    });
    define(
      'canvasConfigureComfy',
      '检查并绑定 ComfyUI 服务',
      [z.uuid(), versionSchema, z.string().min(1).max(120)],
      true,
      async (id, version, connectionId) => {
        const canvas = canvases.get(id);
        if (canvas.version !== version) throw new Error('画布已更新，请重新保存后检查');
        const result = await workflows.comfy.configure(canvas, connectionId);
        ctx.tzEvents.changed();
        return result;
      },
    );
    define(
      'canvasExportComfy',
      '导出 ComfyUI API 工作流',
      [z.uuid(), versionSchema],
      false,
      async (id, version) => {
        const canvas = canvases.get(id);
        if (canvas.version !== version) throw new Error('画布已更新，请重新保存后导出');
        const text = workflows.comfy.export(canvas);
        const result = await dialog.showSaveDialog({
          title: '导出 ComfyUI 工作流',
          defaultPath: canvas.title.replace(/[<>:"/\\|?*]/g, '_') + '.comfy.json',
          filters: [{ name: 'ComfyUI API', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return null;
        const previous = await readFile(result.filePath).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return undefined;
          throw e;
        });
        await writeLocalFile(
          result.filePath,
          Buffer.from(text),
          previous ? createHash('sha256').update(previous).digest('hex') : undefined,
        );
        return result.filePath;
      },
    );
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
    define('canvasReadTextSource', '读取画布节点的文本来源', [resourceSchema], false, (r) =>
      workflows.resources.readTextSource(r),
    );
    define(
      'canvasImportTextUrl',
      '从外部地址导入画布文本来源',
      [z.string().url().max(4000)],
      true,
      async (url) => {
        const source = await fetchCanvasText(url);
        const title = decodeURIComponent(
          new URL(source.url).pathname.split('/').pop() || '网页.html',
        ).slice(0, 170);
        const doc = ctx.tzKnowledge.importFile(
          title + (/\.(html?|svg|md|txt|css|json|xml)$/i.test(title) ? '' : '.txt'),
          Buffer.from(source.text),
          undefined,
          'default',
        );
        ctx.tzEvents.changed();
        return {
          ...source,
          title: doc.title,
          resource: { kind: 'content' as const, id: doc.id, version: doc.version },
        };
      },
    );
    const importResourcesSchema = z
      .object({
        paths: z.array(absolutePathSchema).min(1).max(20).optional(),
        media: z.enum(['image', 'video', 'audio']).optional(),
      })
      .strict();
    define(
      'canvasImportResources',
      '导入外部文件到内容库并返回画布资源引用',
      [importResourcesSchema],
      true,
      async (raw) => {
        const input = importResourcesSchema.parse(raw);
        const chosen = input.paths
          ? { canceled: false, filePaths: input.paths }
          : await dialog.showOpenDialog({
              title: '导入画布资源',
              properties: ['openFile', 'multiSelections'],
              ...(input.media
                ? {
                    filters: [
                      { name: input.media, extensions: canvasMediaExtensions[input.media] },
                    ],
                  }
                : {}),
            });
        if (chosen.canceled) return { choices: [], errors: [] };
        if (chosen.filePaths.length > 20) throw new Error('每次最多导入 20 个文件');
        const result = await importCanvasResources(ctx.tzKnowledge, chosen.filePaths, input.media);
        if (result.choices.length) ctx.tzEvents.changed();
        return result;
      },
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
