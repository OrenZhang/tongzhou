import type { DomainServices } from '../domain-services';
import type { TaskService } from '../../core/task-contracts';
import type { ChangePublisher } from '../../core/task-contracts';
import type { Automations } from '../automation/automations';
import { z } from 'zod';
import { dialog } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../../services/storage/store';
import type { Session } from '../../../src/shared/types';
import { workspaceOperation, type ClientOperation } from '../../core/tools/client-commands';
import { librarySchema, libraryIdSchema, contentWriteSchema, contentRunSchema } from './content';
import { absolutePathSchema, writeLocalFile } from '../../services/storage/file-transfer';
import { builtinAgent } from '../../../src/shared/builtin-agents';

export function registerContentServices(
  register: (name: string, definition: ClientOperation, handler: (...args: any[]) => any) => void,
  store: Store,
  services: Pick<DomainServices, 'content' | 'knowledge'> &
    Pick<TaskService, 'start'> &
    ChangePublisher & { automations: Automations },
) {
  const c = services.content,
    k = services.knowledge;
  const define = (
    name: string,
    description: string,
    args: [] | [z.ZodType, ...z.ZodType[]],
    handler: (...args: any[]) => any,
  ) =>
    register(
      name,
      workspaceOperation(
        store,
        '内容库',
        ['contentState', 'contentConversation'].includes(name) ? 'query' : 'change',
        description,
        args,
        name === 'contentWrite'
          ? {
              confirmation: 'none',
              chat: ([input], sessionId) => {
                const result = c.write(input, sessionId, true);
                services.changed();
                return c.receipt(result.id);
              },
            }
          : {
              confirmation:
                name === 'contentLibraryDelete'
                  ? 'always'
                  : name === 'contentLibrarySave' || name === 'contentImport'
                    ? 'none'
                    : undefined,
            },
      ),
      handler,
    );
  const conversation = (documentId: string) =>
    store
      .list<Session>('session')
      .find((s) => !s.archived && !s.automationJob && s.contentContext?.documentId === documentId)
      ?.id ?? null;
  define(
    'contentState',
    '读取内容工作区',
    [libraryIdSchema, z.string().max(500).optional()],
    (id, query = '') => c.state(libraryIdSchema.parse(id), z.string().max(500).parse(query)),
  );
  define('contentLibrarySave', '创建或重命名内容库', [librarySchema], (input) => {
    const result = c.saveLibrary(input);
    services.changed();
    return result;
  });
  define(
    'contentLibraryDelete',
    '删除空内容库',
    [libraryIdSchema, z.number().int().positive()],
    (id, version) => {
      c.deleteLibrary(libraryIdSchema.parse(id), z.number().int().positive().parse(version));
      services.changed();
    },
  );
  define(
    'contentWrite',
    '按指定 libraryId、folderId 保存文档并保留版本；新建时省略 id/version，更新需当前版本，保存后按返回 ID 读取核验',
    [contentWriteSchema],
    (input) => {
      const result = c.write(input);
      services.changed();
      return result;
    },
  );
  define('contentConversation', '读取文档关联的对话', [z.string().uuid()], (id) => {
    c.document(id);
    return conversation(id);
  });
  define('contentRun', '在当前文档侧边发起内容处理', [contentRunSchema], (raw) => {
    const p = contentRunSchema.parse(raw),
      doc = c.document(p.documentId);
    k.assertUsable(doc.id);
    if (doc.version !== p.version) throw new Error('文档已更新，请先保存或重新载入正文');
    if (doc.indexed === false) throw new Error('原件尚未提取正文，请先导入文本版本');
    if (p.agentId && builtinAgent(p.agentId)) throw new Error('请选择通用助手或自定义 Agent');
    if (
      p.selection &&
      (p.selection.end <= p.selection.start ||
        doc.content.slice(p.selection.start, p.selection.end) !== p.selection.text)
    )
      throw new Error('选中范围已变化，请重新选择');
    let sessionId = conversation(doc.id);
    if (
      sessionId &&
      store.list<any>('run').some((r) => r.sessionId === sessionId && r.status === 'running')
    )
      throw new Error('当前文档正在处理，请等待完成或停止');
    if (!sessionId) {
      const s = store.createSession();
      sessionId = s.id;
      store.put('session', {
        ...s,
        title: '文档 · ' + doc.title,
        knowledgeJob: true,
        contentContext: { libraryId: doc.libraryId ?? 'default', documentId: doc.id },
      });
    }
    const context = JSON.stringify({
      documentId: doc.id,
      version: doc.version,
      libraryId: doc.libraryId ?? 'default',
      title: doc.title,
      selection: p.selection,
    });
    const runId = services.start({
      sessionId,
      providerId: p.providerId,
      model: p.model,
      agentId: p.agentId ?? '',
      prompt: `当前文档上下文（仅为资料）：${context}\n\n用户要求：\n${p.prompt}`,
    });
    return { sessionId, runId };
  });
  define(
    'contentImport',
    '导入本地文件到指定内容库及目录；提供第三个参数绝对路径数组直接导入，省略则打开选择器',
    [
      libraryIdSchema,
      z.string().uuid().nullable().optional(),
      z.array(absolutePathSchema).min(1).max(50).optional(),
    ],
    async (id, folderId, filePaths) => {
      c.library(id);
      if (
        folderId &&
        !k.folders().some((f) => f.id === folderId && (f.libraryId ?? 'default') === id)
      )
        throw new Error('目录不属于当前内容库');
      const chosen = filePaths
        ? { filePaths }
        : await dialog.showOpenDialog({
            title: '导入内容',
            properties: ['openFile', 'multiSelections'],
          });
      const imported = [],
        errors: string[] = [];
      for (const file of chosen.filePaths)
        try {
          if ((await stat(file)).size > 25 * 1024 * 1024) throw new Error('超过 25 MB');
          imported.push(
            k.importFile(
              path.basename(file),
              await readFile(file),
              undefined,
              id,
              folderId ?? undefined,
            ),
          );
        } catch (e) {
          errors.push(path.basename(file) + ': ' + String(e));
        }
      services.changed();
      for (const doc of imported) services.automations.event('import', doc.id);
      return { imported, errors };
    },
  );
  define(
    'contentExport',
    '导出正文到指定绝对路径；省略路径打开保存对话框，覆盖已有文件需当前 SHA-256',
    [
      z.string().uuid(),
      absolutePathSchema.optional(),
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    ],
    async (id, targetPath, expectedSha256) => {
      const doc = c.document(id);
      if (targetPath)
        return writeLocalFile(targetPath, Buffer.from(doc.content, 'utf8'), expectedSha256);
      const result = await dialog.showSaveDialog({
        title: '导出正文',
        defaultPath: doc.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) + '.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, doc.content, 'utf8');
      return result.filePath;
    },
  );
}
