import { z } from 'zod';
import { manual } from '../../core/tools/client-commands';
import { attachmentUploadSchema } from '../../modules/artifacts/attachments';
import type { Plugin } from 'cordis';
import '../context';

export const attachmentsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-attachments',
  inject: ['tzIpc', 'tzAttachments'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const attachments = ctx.tzAttachments;
    register(
      'uploadAttachment',
      manual('会话', '添加图片或文本附件', 'workspace', '由用户在输入框选择或粘贴文件', [
        attachmentUploadSchema,
      ]),
      (raw) => attachments.save(raw),
    );
    register(
      'attachmentContent',
      manual('会话', '预览已添加附件', 'workspace', '模型通过当前会话的 read_attachment 读取附件', [
        z.uuid(),
      ]),
      (id) => attachments.content(id),
    );
  },
};
