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
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx),
      store = ctx.tzStore,
      canvases = ctx.tzCanvases,
      workflows = ctx.tzCanvasWorkflows;
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
            media: z.enum(['image', 'video']).optional(),
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
            media: z.enum(['image', 'video']).optional(),
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
                      (p.media === 'image' ? /\.(png|jpe?g|webp)$/i : /\.(mp4|webm)$/i).test(
                        d.fileName ?? '',
                      )),
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
