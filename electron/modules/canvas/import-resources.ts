import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { Knowledge } from '../knowledge/knowledge';
import type { CanvasResource } from '../../../src/shared/canvas';

export const canvasMediaExtensions = {
  image: ['png', 'jpg', 'jpeg', 'webp'],
  video: ['mp4', 'webm'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac'],
};
export type CanvasImportMedia = keyof typeof canvasMediaExtensions;

export async function importCanvasResources(
  knowledge: Pick<Knowledge, 'importFile'>,
  files: string[],
  media?: CanvasImportMedia,
) {
  const choices: { title: string; resource: CanvasResource }[] = [];
  const errors: string[] = [];
  for (const file of [...new Set(files)]) {
    const name = path.basename(file);
    try {
      if (
        media &&
        !canvasMediaExtensions[media].includes(path.extname(name).slice(1).toLowerCase())
      )
        throw new Error('文件格式不适用于当前节点');
      const info = await stat(file);
      if (!info.isFile()) throw new Error('请选择文件，不能导入文件夹');
      if (info.size > 25 * 1024 * 1024) throw new Error('单个资料文件最多 25 MB');
      const bytes = await readFile(file);
      // importFile also checks size, copies the original and deduplicates content.
      const doc = knowledge.importFile(name, bytes, undefined, 'default');
      if (
        !choices.some(
          (choice) => choice.resource.kind === 'content' && choice.resource.id === doc.id,
        )
      )
        choices.push({
          title: doc.title,
          resource: { kind: 'content', id: doc.id, version: doc.version },
        });
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { choices, errors };
}
