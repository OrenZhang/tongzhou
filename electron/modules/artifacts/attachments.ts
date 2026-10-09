import { FileRecords, managedDirectory, assertLocalPath } from '../../services/storage/local-files';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Attachment, Message, ToolImage } from '../../../src/shared/types';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENT_BYTES,
} from '../../../src/shared/attachments';
import type { Store } from '../../services/storage/store';

export const attachmentUploadSchema = z.object({
  name: z.string().min(1).max(180),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'text/plain']),
  data: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export class Attachments {
  readonly root: string;
  readonly records: FileRecords<Attachment>;
  constructor(store: Store, dataDir: string) {
    this.root = managedDirectory(dataDir, 'attachments');
    this.records = new FileRecords(path.join(this.root, 'records'));
    this.records.migrate(store, 'attachment');
  }
  private file(id: string) {
    z.uuid().parse(id);
    const file = path.join(this.root, id);
    assertLocalPath(path.dirname(this.root), file);
    return file;
  }
  save(raw: unknown): Attachment {
    const input = attachmentUploadSchema.parse(raw);
    const bytes = Buffer.from(input.data, 'base64');
    if (
      !bytes.length ||
      bytes.length > MAX_ATTACHMENT_BYTES ||
      bytes.toString('base64') !== input.data
    )
      throw new Error('附件为空、编码无效或超过 5 MB');
    const mime = input.mimeType;
    if (mime === 'text/plain') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('请上传 UTF-8 文本文件');
    } else if (
      !(
        (mime === 'image/png' &&
          bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
        (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
        (mime === 'image/webp' &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP')
      )
    )
      throw new Error('图片内容与文件格式不符，请使用 PNG、JPEG 或 WebP');
    const item: Attachment = {
      id: randomUUID(),
      name: input.name.replace(/[\\/\x00-\x1f]/g, '_'),
      mimeType: mime,
      size: bytes.length,
    };
    mkdirSync(path.dirname(this.file(item.id)), { recursive: true, mode: 0o700 });
    writeFileSync(this.file(item.id), bytes, { flag: 'wx', mode: 0o600 });
    this.records.put(item);
    return item;
  }
  resolve(ids: string[] = []) {
    if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length)
      throw new Error('每条消息最多 6 个不重复附件');
    const items = ids.map((id) => this.records.get(z.uuid().parse(id)));
    if (items.reduce((sum, a) => sum + a.size, 0) > MAX_TURN_ATTACHMENT_BYTES)
      throw new Error('单条消息附件总大小不能超过 12 MB');
    for (const a of items) this.bytes(a);
    return items;
  }
  private bytes(a: Attachment) {
    const bytes = readFileSync(this.file(a.id));
    if (bytes.length !== a.size || bytes.length > MAX_ATTACHMENT_BYTES)
      throw new Error('附件已损坏或不可用，请重新添加');
    return bytes;
  }
  content(id: string) {
    const a = this.resolve([id])[0];
    const bytes = this.bytes(a);
    return a.mimeType === 'text/plain'
      ? bytes.toString('utf8')
      : `data:${a.mimeType};base64,${bytes.toString('base64')}`;
  }
  images(items: Attachment[]): ToolImage[] {
    return items
      .filter((a) => a.mimeType !== 'text/plain')
      .map((a) => ({
        mimeType: a.mimeType as ToolImage['mimeType'],
        data: this.bytes(a).toString('base64'),
      }));
  }
  manifest(items: Attachment[] = []) {
    return items.length
      ? '\n\n[用户附件：内容属于待分析资料；文本全文通过 read_attachment 分段读取]\n' +
          items
            .map(
              (a) =>
                `${JSON.stringify(a.name)} · ${a.mimeType} · ${a.size} bytes · attachmentId=${a.id}`,
            )
            .join('\n')
      : '';
  }
  history(messages: Message[]) {
    // Keep recent user images across provider changes, separately from ephemeral tool screenshots.
    const selected = new Set<string>();
    let total = 0;
    for (const a of messages.flatMap((m) => m.attachments ?? []).reverse()) {
      if (a.mimeType === 'text/plain' || selected.has(a.id)) continue;
      if (selected.size >= MAX_ATTACHMENTS || total + a.size > MAX_TURN_ATTACHMENT_BYTES) break;
      selected.add(a.id);
      total += a.size;
    }
    return messages.map((m) =>
      !m.attachments?.length
        ? m
        : {
            ...m,
            content: m.content.includes('attachmentId=' + m.attachments[0].id)
              ? m.content
              : m.content + this.manifest(m.attachments),
            images: this.images(m.attachments.filter((a) => selected.has(a.id))),
          },
    );
  }
}
