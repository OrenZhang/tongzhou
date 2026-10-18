import { t as tr } from '../../shared/i18n';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Modal } from '../../components/components';
import type { CanvasResource } from '../../shared/canvas';
import type { ArtifactPreview } from '../../shared/artifacts';
import type { TongzhouAPI } from '../../shared/types';

export type CanvasPreviewItem = { resource: CanvasResource; title: string };
export const resourceKey = (r: CanvasResource) => JSON.stringify(r);

/** One viewer for referenced assets and generated batches. Remember the last viewed resource. */
export function CanvasPreview({
  api,
  items,
  initial,
  storageKey,
  onClose,
}: {
  api: TongzhouAPI;
  items: CanvasPreviewItem[];
  initial?: string;
  storageKey: string;
  onClose(): void;
}) {
  const [media, setMedia] = useState<(CanvasPreviewItem & { preview: ArtifactPreview })[]>([]),
    [loading, setLoading] = useState(true),
    [selected, setSelected] = useState(() => {
      if (initial) return initial;
      try {
        return localStorage.getItem(storageKey) ?? '';
      } catch {
        return '';
      }
    });
  useEffect(() => {
    let live = true;
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      const key = resourceKey(item.resource);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    void Promise.all(
      unique.map(async (item) => {
        try {
          return { ...item, preview: await api.canvasResourcePreview(item.resource) };
        } catch {
          return undefined;
        }
      }),
    ).then((results) => {
      if (!live) return;
      setMedia(
        results.filter(
          (item): item is NonNullable<typeof item> =>
            !!item &&
            ['image', 'video', 'audio'].includes(item.preview.type) &&
            !!item.preview.content,
        ),
      );
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [api, items]);
  const index = Math.max(
      0,
      media.findIndex((item) => resourceKey(item.resource) === selected),
    ),
    current = media[index];
  const choose = (index: number) => {
    if (!media[index]) return;
    setSelected(resourceKey(media[index].resource));
  };
  useEffect(() => {
    if (!current) return;
    try {
      localStorage.setItem(storageKey, resourceKey(current.resource));
    } catch {
      /* Preview works without browser storage. */
    }
  }, [current, storageKey]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select'))
        return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      choose(index + (event.key === 'ArrowLeft' ? -1 : 1));
    };
    document.addEventListener('keydown', handle, true);
    return () => document.removeEventListener('keydown', handle, true);
  }, [media, index]);
  return createPortal(
    <Modal title={tr('画布媒体预览')} onClose={onClose} wide>
      {loading ? (
        <p role="status">{tr('正在读取原件…')}</p>
      ) : !current ? (
        <p>{tr('没有可预览的媒体，原件可能已移除。')}</p>
      ) : (
        <>
          <div className="canvas-preview-controls">
            <button
              aria-label={tr('上一张')}
              disabled={index === 0}
              onClick={() => choose(index - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              <strong>{current.title}</strong>
              <small aria-live="polite">
                {index + 1} / {media.length}
              </small>
            </span>
            <button
              aria-label={tr('下一张')}
              disabled={index === media.length - 1}
              onClick={() => choose(index + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {current.preview.type === 'audio' ? (
            <audio
              key={resourceKey(current.resource)}
              src={current.preview.content}
              controls
              autoPlay
            />
          ) : current.preview.type === 'video' ? (
            <video
              key={resourceKey(current.resource)}
              className="canvas-media-lightbox"
              src={current.preview.content}
              controls
              autoPlay
            />
          ) : (
            <img
              className="canvas-media-lightbox"
              src={current.preview.content}
              alt={current.title}
            />
          )}
          {media.length > 1 && (
            <div className="canvas-preview-strip" aria-label={tr('预览图片列表')}>
              {media.map((item, i) => (
                <button
                  key={resourceKey(item.resource)}
                  aria-label={tr('预览第 {0} 张：{1}', [i + 1, item.title])}
                  aria-pressed={i === index}
                  onClick={() => choose(i)}
                >
                  {item.preview.type === 'image' ? (
                    <img src={item.preview.content} alt="" />
                  ) : (
                    <span>
                      {item.preview.type === 'audio' ? tr('音频') : tr('视频')} {i + 1}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>,
    document.body,
  );
}
