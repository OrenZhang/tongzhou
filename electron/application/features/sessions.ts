import { dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Project, Session } from '../../../src/shared/types';
import { manual, operation, workspaceOperation } from '../../core/tools/client-commands';
import { idSchema, redact, runSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const sessionsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-sessions',
  inject: [
    'tzIpc',
    'tzStore',
    'tzRuntime',
    'tzSessions',
    'tzApprovals',
    'tzChannels',
    'tzFeishu',
    'tzDesktop',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = ctx.tzRuntime;
    const channels = ctx.tzChannels;
    const feishu = ctx.tzFeishu;
    const { getWindow } = ctx.tzDesktop;
    register(
      'branchSession',
      operation('会话', 'change', '从指定消息创建会话分支', [
        idSchema.describe('sessionId'),
        idSchema.describe('messageId'),
      ]),
      (raw, rawMessage) => {
        const id = idSchema.parse(raw),
          messageId = idSchema.parse(rawMessage);
        const source = store.get<Session>('session', id);
        const messages = store.messages(id);
        const index = messages.findIndex((m) => m.id === messageId);
        if (index < 0 || messages[index].status === 'streaming')
          throw new Error('请选择已完成的历史消息');
        const copy = store.createSession(source.projectId);
        const result = {
          ...copy,
          providerId: source.providerId,
          model: source.model,
          agentId: source.agentId,
          permission: source.permission,
          title: source.title + ' · 分支',
        };
        store.db.exec('BEGIN');
        try {
          store.put('session', result);
          // Keep portable evidence; do not leave partial tool call pairs in the new branch.
          for (const m of messages.slice(0, index + 1))
            store.message({
              ...m,
              id: randomUUID(),
              sessionId: copy.id,
              runId: undefined,
              toolCalls: undefined,
              toolCallId: undefined,
              anthropicContent: undefined,
              role: m.role === 'tool' ? 'assistant' : m.role,
              content: m.role === 'tool' ? '[分支前的工具记录] ' + m.content : m.content,
            });
          store.db.exec('COMMIT');
        } catch (e) {
          store.db.exec('ROLLBACK');
          store.deleteSession(copy.id);
          throw e;
        }
        runtime.changed();
        return result;
      },
    );
    register(
      'runEvents',
      operation('会话', 'query', '查询会话运行事件和进度', [
        idSchema.describe('sessionId'),
        z.string().optional(),
      ]),
      (id, before) => runtime.events(idSchema.parse(id), z.string().optional().parse(before)),
    );
    register(
      'enqueue',
      operation(
        '会话',
        'change',
        '给其他会话补充内容、排队下一轮或重新运行',
        [runSchema, z.enum(['supplement', 'next', 'restart'])],
        {
          guard: (args, current) => {
            if ((args[0] as { sessionId: string }).sessionId === current)
              throw new Error('请使用当前会话的输入框或菜单操作当前任务');
          },
        },
      ),
      (input, mode) =>
        runtime.enqueue(
          runSchema.parse(input),
          z.enum(['supplement', 'next', 'restart']).parse(mode),
        ),
    );
    register(
      'cancelInput',
      operation('会话', 'change', '取消排队输入', [idSchema.describe('inputId')]),
      (id) => runtime.cancelInput(idSchema.parse(id)),
    );
    register(
      'resumeInput',
      operation('会话', 'change', '恢复暂停的排队输入', [idSchema.describe('inputId')]),
      (id) => runtime.resumeInput(idSchema.parse(id)),
    );
    register(
      'editInput',
      operation('会话', 'change', '修改排队输入内容', [
        idSchema.describe('inputId'),
        z.string().min(1).max(100000),
      ]),
      (id, prompt) => runtime.editInput(idSchema.parse(id), z.string().max(100000).parse(prompt)),
    );
    register(
      'resendMessage',
      manual(
        '会话',
        '编辑并重发最后一条未收到回复的消息',
        'workspace',
        '请由用户在原消息的编辑入口修改并重新发送',
        [idSchema.describe('messageId'), runSchema],
      ),
      (id, input) => runtime.start(runSchema.parse(input), idSchema.parse(id)),
    );
    register(
      'deleteSession',
      operation(
        '会话',
        'change',
        '删除已归档的会话及消息记录；执行中的会话须先停止',
        [idSchema.describe('sessionId')],
        {
          confirmation: 'always',
          guard: (args, current) => {
            if (args[0] === current) throw new Error('请使用当前会话的输入框或菜单操作当前任务');
          },
        },
      ),
      async (id) => {
        idSchema.parse(id);
        await ctx.tzSessions.deleteSession(id);
        channels.abort(id);
        feishu.sync();
      },
    );
    register(
      'messages',
      operation('会话', 'query', '分页查看会话历史消息', [
        idSchema.describe('sessionId'),
        z
          .object({
            before: idSchema.optional(),
            limit: z.number().int().min(1).max(500).optional(),
          })
          .optional(),
      ]),
      (id, raw) => {
        const options = z
          .object({
            before: idSchema.optional(),
            limit: z.number().int().min(1).max(500).optional(),
          })
          .parse(raw ?? {});
        return store.messagesPage(idSchema.parse(id), options.before, options.limit);
      },
    );
    register(
      'readMessage',
      operation('会话', 'query', '分段读取消息完整原文', [
        idSchema.describe('sessionId'),
        idSchema.describe('messageId'),
        z
          .object({
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(8000).optional(),
          })
          .optional(),
      ]),
      (sessionId, messageId, raw) => {
        const options = z
          .object({
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(8000).optional(),
          })
          .parse(raw ?? {});
        return store.readMessage(
          idSchema.parse(sessionId),
          idSchema.parse(messageId),
          options.offset,
          options.limit,
        );
      },
    );
    register(
      'createSession',
      operation('会话', 'change', '新建普通会话或项目会话', [
        idSchema.nullable().optional().describe('projectId，留空创建普通聊天'),
      ]),
      (id) => {
        if (id && store.get<Project>('project', idSchema.parse(id)).removed)
          throw new Error('工作树已移除，不能创建新会话');
        const s = store.createSession(idSchema.nullish().parse(id) ?? null);
        runtime.changed();
        return s;
      },
    );
    register(
      'updateSession',
      operation('会话', 'change', '修改标题、归档状态或模型连接；运行中不能切换连接', [
        idSchema.describe('sessionId'),
        z.object({
          title: z.string().min(1).max(120).optional(),
          archived: z.boolean().optional(),
          providerId: idSchema.optional(),
          model: z.string().min(1).max(200).optional(),
        }),
      ]),
      (raw, patch) => {
        const id = idSchema.parse(raw);
        if (ctx.tzSessions.isDeleting(id)) throw new Error('会话正在删除，请稍候');
        const update = z
          .object({
            title: z.string().trim().min(1).max(120).optional(),
            archived: z.boolean().optional(),
            providerId: idSchema.optional(),
            model: z.string().max(200).optional(),
          })
          .parse(patch);
        if (
          runtime.isActive(id) &&
          (update.archived || update.providerId !== undefined || update.model !== undefined)
        )
          throw new Error(
            update.archived ? '请先停止执行，再归档会话' : '请先停止执行，再切换模型',
          );
        if (update.providerId) store.get('provider', update.providerId);
        store.put('session', {
          ...store.get<Session>('session', id),
          ...update,
          updatedAt: Date.now(),
        });
        runtime.changed();
      },
    );
    register(
      'run',
      operation('会话', 'change', '启动其他会话的任务', [runSchema], {
        guard: (args, current) => {
          if ((args[0] as { sessionId: string }).sessionId === current)
            throw new Error('请使用当前会话的输入框或菜单操作当前任务');
        },
      }),
      (input) => runtime.start(runSchema.parse(input)),
    );
    register(
      'team',
      operation(
        '会话',
        'change',
        '在其他会话启动最多三个 Agent 协作',
        [runSchema, z.array(idSchema).min(1).max(3)],
        {
          guard: (args, current) => {
            if ((args[0] as { sessionId: string }).sessionId === current)
              throw new Error('请使用当前会话的输入框或菜单操作当前任务');
          },
        },
      ),
      (input, ids) =>
        runtime.team(runSchema.parse(input), z.array(idSchema).min(1).max(3).parse(ids)),
    );
    register(
      'cancel',
      operation('会话', 'change', '停止指定其他会话的任务', [idSchema.describe('sessionId')], {
        guard: (args, current) => {
          if (args[0] === current) throw new Error('请使用当前会话的输入框或菜单操作当前任务');
        },
      }),
      (id) => runtime.cancel(idSchema.parse(id)),
    );
    register(
      'approve',
      manual(
        '权限',
        '批准或拒绝待审批操作',
        'workspace',
        '只有用户可以审批，Agent 不能批准自身或其他会话的操作',
        [idSchema, z.boolean()],
      ),
      (id, allow) => ctx.tzApprovals.approve(idSchema.parse(id), z.boolean().parse(allow)),
    );
    register(
      'exportSession',
      workspaceOperation(store, '会话', 'change', '导出会话为 Markdown', [
        idSchema.describe('sessionId'),
      ]),
      async (raw) => {
        const id = idSchema.parse(raw);
        const s = store.get<Session>('session', id);
        const result = await dialog.showSaveDialog(getWindow()!, {
          title: '导出会话',
          defaultPath: `Tongzhou-${s.id.slice(0, 8)}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (result.canceled || !result.filePath) return null;
        const content =
          `# ${s.title}\n\n导出自同舟 · ${new Date().toISOString()}\n\n` +
          store
            .messages(id)
            .map(
              (m) => `## ${m.agent ?? m.role}${m.model ? ' · ' + m.model : ''}\n\n${m.content}\n`,
            )
            .join('\n');
        await writeFile(result.filePath, redact(content), 'utf8');
        return result.filePath;
      },
    );
  },
};
