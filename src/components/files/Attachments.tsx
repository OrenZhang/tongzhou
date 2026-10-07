import { FilePreviewContext } from './FilePreviewContext';
import { WorkspaceFrame } from '../../features/workspace/WorkspaceFrame';
import type { WorkspaceLayout } from '../../features/workspace/workspace-state';
import { useContext, useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import { FileLink } from './FileLink';
import type { Attachment, AttachmentUpload } from '../../shared/types';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENT_BYTES,
} from '../../shared/attachments';
import './attachments.css';

const draftKey = 'tongzhou-attachment-drafts';
function loadDrafts(): Record<string, Attachment[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(draftKey) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
export function useAttachmentDraft(sessionId: string, report: (error: unknown) => void) {
  const [drafts, setDrafts] = useState(loadDrafts);
  const [pending, setPending] = useState(false);
  const uploading = useRef(false);
  const key = sessionId || '_new';
  const items = Array.isArray(drafts[key]) ? drafts[key] : [];
  const update = (target: string, fn: (items: Attachment[]) => Attachment[]) =>
    setDrafts((old) => {
      const next = { ...old, [target]: fn(old[target] ?? []) };
      try {
        localStorage.setItem(draftKey, JSON.stringify(next));
      } catch {
        /* retain in memory */
      }
      return next;
    });
  const addFiles = async (files: File[]) => {
    if (uploading.current) {
      report('附件仍在添加，请稍后再试');
      return false;
    }
    uploading.current = true;
    setPending(true);
    try {
      if (items.length + files.length > MAX_ATTACHMENTS)
        throw new Error('每条消息最多添加 6 个附件');
      if (
        items.reduce((sum, a) => sum + a.size, 0) + files.reduce((sum, f) => sum + f.size, 0) >
        MAX_TURN_ATTACHMENT_BYTES
      )
        throw new Error('本条消息的附件总大小不能超过 12 MB');
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 5 MB`);
        const mimeType =
          file.type ||
          (/\.(txt|md|json|csv|log|[cm]?[jt]sx?|py|ya?ml|css|html)$/i.test(file.name)
            ? 'text/plain'
            : '');
        const mime =
          mimeType.startsWith('text/') || mimeType === 'application/json' ? 'text/plain' : mimeType;
        if (!['image/png', 'image/jpeg', 'image/webp', 'text/plain'].includes(mime))
          throw new Error('支持 PNG、JPEG、WebP 图片和 UTF-8 文本文件');
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('读取附件失败'));
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.readAsDataURL(file);
        });
        const saved = await window.tongzhou.uploadAttachment({
          name: file.name || '粘贴图片.png',
          mimeType: mime as AttachmentUpload['mimeType'],
          data,
        });
        update(key, (old) => [...old, saved]);
      }
      return true;
    } catch (e) {
      report(e);
      return false;
    } finally {
      uploading.current = false;
      setPending(false);
    }
  };
  return {
    items,
    pending,
    addFiles,
    copyTo: (target: string) => update(target, () => items),
    remove: (id: string) => update(key, (old) => old.filter((a) => a.id !== id)),
    clear: (target: string, sent: Attachment[]) =>
      update(target || '_new', (old) => old.filter((a) => !sent.some((s) => s.id === a.id))),
  };
}

function AttachmentCard({
  item,
  onOpen,
  onRemove,
}: {
  item: Attachment;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className={'attachment-card ' + (item.mimeType === 'text/plain' ? 'is-text' : '')}>
      <FileLink
        className="attachment-open"
        onOpen={onOpen}
        name={item.name}
        title={`预览 ${item.name} · ${item.size < 1024 ? item.size + ' B' : Math.ceil(item.size / 1024) + ' KB'}`}
        label={`预览附件 ${item.name}`}
        icon={item.mimeType !== 'text/plain' ? <ImageIcon size={15} /> : undefined}
      />
      {onRemove && (
        <button
          type="button"
          className="attachment-remove"
          onClick={onRemove}
          title="移除附件"
          aria-label={`移除附件 ${item.name}`}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
export function AttachmentCards({
  items = [],
  onRemove,
}: {
  items?: Attachment[];
  onRemove?: (id: string) => void;
}) {
  const open = useContext(FilePreviewContext);
  return items.length ? (
    <div className="attachment-strip">
      {items.map((a) => (
        <AttachmentCard
          key={a.id}
          item={a}
          onOpen={() => open(a)}
          onRemove={onRemove ? () => onRemove(a.id) : undefined}
        />
      ))}
    </div>
  ) : null;
}

export function AttachmentPreview({
  item,
  layout,
  updateLayout,
  onClose,
}: {
  item: Attachment;
  layout: WorkspaceLayout;
  updateLayout(patch: Partial<WorkspaceLayout>): void;
  onClose(): void;
}) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setContent(undefined);
    setError('');
    void window.tongzhou
      .attachmentContent(item.id)
      .then((value) => {
        if (live) setContent(value);
      })
      .catch(() => {
        if (live) setError('附件无法读取，请重新添加');
      });
    return () => {
      live = false;
    };
  }, [item.id]);
  return (
    <WorkspaceFrame
      className="attachment-workspace"
      label="文件工作区"
      width={layout.width}
      expanded={layout.expanded}
      onResize={(width) => updateLayout({ width, expanded: false })}
      onExpand={() => updateLayout({ expanded: !layout.expanded })}
      onClose={onClose}
      header={
        <strong className="workspace-file-title" title={item.name}>
          {item.name}
        </strong>
      }
    >
      <div className="attachment-preview">
        {error ? (
          <p role="alert">{error}</p>
        ) : content === undefined ? (
          <p>正在加载…</p>
        ) : item.mimeType === 'text/plain' ? (
          <pre>{content}</pre>
        ) : (
          <img src={content} alt={item.name} />
        )}
      </div>
    </WorkspaceFrame>
  );
}
