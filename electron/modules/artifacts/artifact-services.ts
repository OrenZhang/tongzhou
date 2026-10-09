import type { DocumentHost } from '../content/document-host';
import type { DomainServices } from '../domain-services';
import type { ChangePublisher } from '../../core/task-contracts';
import type { Automations } from '../automation/automations';
import type { Store } from '../../services/storage/store';
import { z } from 'zod';
import { workspaceOperation, type ClientOperation } from '../../core/tools/client-commands';
import { artifactQuerySchema } from './artifacts';
import { absolutePathSchema } from '../../services/storage/file-transfer';
import { libraryIdSchema } from '../content/content';

export function registerArtifactServices(
  register: (name: string, operation: ClientOperation, handler: (...args: any[]) => any) => void,
  services: Pick<DomainServices, 'artifacts' | 'content' | 'knowledge'> &
    ChangePublisher & { files: DocumentHost; automations: Automations; store: Store },
) {
  const a = services.artifacts,
    id = z.string().uuid();
  const define = (
    name: string,
    description: string,
    args: [] | [z.ZodType, ...z.ZodType[]],
    fn: (...args: any[]) => any,
  ) =>
    register(
      name,
      workspaceOperation(
        services.store,
        '作品',
        ['artifactList', 'artifactRead', 'artifactPreview'].includes(name) ? 'query' : 'change',
        description,
        args,
        {
          confirmation:
            name === 'artifactDelete'
              ? 'always'
              : name === 'artifactToKnowledge'
                ? 'none'
                : undefined,
        },
      ),
      fn,
    );
  define('artifactList', '查看聊天生成的作品', [artifactQuerySchema.optional()], (p) => a.list(p));
  define('artifactRead', '读取作品信息', [id], (v) => a.read(v));
  define('artifactPreview', '预览作品', [id], (v) => a.preview(v));
  define('artifactOpen', '打开作品原件或外部链接', [id], async (v) => {
    const item = a.read(v);
    if (item.remoteUrl) {
      await services.files.openExternal(item.remoteUrl);
      return;
    }
    await services.files.openPath(a.openPath(v));
  });
  define(
    'artifactExport',
    '另存作品副本；提供绝对路径直接导出，覆盖需当前 SHA-256',
    [
      id,
      absolutePathSchema.optional(),
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    ],
    async (v, targetPath, expectedSha256) => {
      const item = a.read(v),
        bytes = a.bytes(v);
      if (targetPath) return services.files.writeTo(targetPath, bytes, expectedSha256);
      return !!(await services.files.saveCopy(bytes, '下载作品', item.name));
    },
  );
  define('artifactDelete', '删除保存的作品副本，不修改原始项目文件', [id], (v) => {
    a.delete(v);
    services.changed();
  });
  define(
    'artifactToKnowledge',
    '按用户指定的位置直接把作品保存到内容库，无需再次点击入库；返回文档 ID 可用 knowledgeRead 核验',
    [id, libraryIdSchema, id.nullable().optional(), z.string().trim().min(1).max(100).optional()],
    (v, libraryId, folderId, newFolderName) => {
      services.content.library(libraryId);
      if (
        folderId &&
        !services.knowledge
          .folders()
          .some((f) => f.id === folderId && (f.libraryId ?? 'default') === libraryId)
      )
        throw new Error('目录不属于当前内容库');
      const item = a.read(v),
        bytes = a.bytes(v);
      const targetFolder = newFolderName
        ? services.knowledge.saveFolder({ name: newFolderName, libraryId, parentId: folderId }).id
        : folderId;
      const doc = services.knowledge.importFile(
        item.name,
        bytes,
        item.projectId,
        libraryId,
        targetFolder ?? undefined,
        true,
      );
      if (!doc.sessionId)
        services.knowledge.persist({ ...doc, sessionId: item.sessionId, runId: item.runId }, doc);
      services.automations.event('import', doc.id);
      services.changed();
      return doc.id;
    },
  );
}
