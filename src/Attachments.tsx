import { useEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import type { Attachment, AttachmentUpload } from './shared/types';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENT_BYTES,
} from './shared/attachments';
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
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    if (item.mimeType !== 'text/plain')
      void window.tongzhou
        .attachmentContent(item.id)
        .then((value) => {
          if (live) setImage(value);
        })
        .catch(() => {
          if (live) setError('图片不可用');
        });
    return () => {
      live = false;
    };
  }, [item.id, item.mimeType]);
  return (
    <div className={'attachment-card ' + (item.mimeType === 'text/plain' ? 'is-text' : '')}>
      <button
        type="button"
        className="attachment-open"
        onClick={onOpen}
        title={`预览 ${item.name}`}
        aria-label={`预览附件 ${item.name}`}
      >
        {image ? <img src={image} alt={item.name} /> : <FileText size={20} />}
        <span>
          {item.name}
          <small>
            {error || (item.size < 1024 ? item.size + ' B' : Math.ceil(item.size / 1024) + ' KB')}
          </small>
        </span>
      </button>
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
  const [preview, setPreview] = useState<Attachment>();
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!preview) return;
    let live = true;
    setContent('');
    setError('');
    dialog.current?.showModal();
    void window.tongzhou
      .attachmentContent(preview.id)
      .then((value) => {
        if (live) setContent(value);
      })
      .catch(() => {
        if (live) setError('附件无法读取，请重新添加');
      });
    return () => {
      live = false;
    };
  }, [preview]);
  return (
    <>
      {!!items.length && (
        <div className="attachment-strip">
          {items.map((a) => (
            <AttachmentCard
              key={a.id}
              item={a}
              onOpen={() => setPreview(a)}
              onRemove={onRemove ? () => onRemove(a.id) : undefined}
            />
          ))}
        </div>
      )}
      {preview && (
        <dialog
          ref={dialog}
          className="attachment-dialog"
          onClose={() => setPreview(undefined)}
          onClick={(e) => {
            if (e.target === e.currentTarget) dialog.current?.close();
          }}
        >
          <header>
            <strong>{preview.name}</strong>
            <button
              autoFocus
              className="icon-button"
              aria-label="关闭附件预览"
              onClick={() => dialog.current?.close()}
            >
              <X size={18} />
            </button>
          </header>
          {error ? (
            <p role="alert">{error}</p>
          ) : !content ? (
            <p>正在加载…</p>
          ) : preview.mimeType === 'text/plain' ? (
            <pre>{content}</pre>
          ) : (
            <img src={content} alt={preview.name} />
          )}
        </dialog>
      )}
    </>
  );
}
