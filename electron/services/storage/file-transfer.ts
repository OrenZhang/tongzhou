import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { z } from 'zod';

export const absolutePathSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => path.isAbsolute(value), '必须使用本地绝对路径');
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Paths are supplied explicitly; no shell quoting or project binding is needed. */
export async function writeLocalFile(file: string, bytes: Uint8Array, expectedSha256?: string) {
  absolutePathSchema.parse(file);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, expectedSha256 ? 'r+' : 'wx');
  try {
    if (expectedSha256) {
      const current = await handle.readFile();
      if (digest(current) !== expectedSha256) throw new Error('文件已变化，请重新读取后再保存');
    }
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error('文件写入未完成');
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const actual = await readFile(file);
  if (!actual.equals(Buffer.from(bytes))) throw new Error('文件读回核验失败');
  return {
    path: path.resolve(file),
    persisted: true,
    bytes: actual.length,
    sha256: digest(actual),
  };
}
