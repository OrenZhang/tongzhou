import type { Knowledge } from '../../electron/modules/knowledge/knowledge';
import type { KnowledgeDocument } from '../../src/shared/knowledge';
/** Place fixture data in a common directory without adding content revisions. */
export function authorizeKnowledgeFixtures(k: Knowledge, ...documents: KnowledgeDocument[]) {
  for (const doc of documents) {
    if (doc.kind === 'memory') continue;
    let folder = doc.folderId ? k.folders().find((f) => f.id === doc.folderId) : undefined;
    if (!folder)
      folder =
        k
          .folders()
          .find(
            (f) =>
              f.name === '已授权测试资料' &&
              (f.libraryId ?? 'default') === (doc.libraryId ?? 'default'),
          ) ?? k.saveFolder({ name: '已授权测试资料', libraryId: doc.libraryId });
    doc.folderId = folder.id;
    k.persist(doc);
  }
}
