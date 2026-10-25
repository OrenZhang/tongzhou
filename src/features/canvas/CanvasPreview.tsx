import { t as tr } from '../../shared/i18n';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Modal } from '../../components/components';
import type { CanvasResource } from '../../shared/canvas';
import type { ArtifactPreview } from '../../shared/artifacts';
import type { TongzhouAPI } from '../../shared/types';
import {
  canvasPreviewIssue,
  invalidateCanvasPreview,
  resourceKey,
  type CanvasPreviewItem,
} from '../../shared/canvas-preview';
import { errorMessage } from '../../lib/feedback';

export { resourceKey, type CanvasPreviewItem } from '../../shared/canvas-preview';
type LoadedPreview = CanvasPreviewItem & { preview?: ArtifactPreview; error?: string };

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
  const [loaded, setLoaded] = useState<LoadedPreview[]>([]),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0),
    [downloading, setDownloading] = useState(false),
    [loadError, setLoadError] = useState<{ key: string; message: string }>(),
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
    setLoading(true);
    setLoadError(undefined);
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      const key = resourceKey(item.resource);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    void Promise.all(
      unique.map(async (item): Promise<LoadedPreview> => {
        try {
          return { ...item, preview: await api.canvasResourcePreview(item.resource) };
        } catch (error) {
          return { ...item, error: errorMessage(error) };
        }
      }),
    ).then((results) => {
      if (!live) return;
      setLoaded(results);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [api, items, attempt]);
  // Keep failed originals selectable; never silently replace a clicked image with another one.
  const media = loaded.filter(
    (item) =>
      item.error ||
      item.preview?.type === 'external' ||
      ['image', 'video', 'audio'].includes(item.preview?.type ?? '') ||
      resourceKey(item.resource) === selected,
  );
  const index = Math.max(
      0,
      media.findIndex((item) => resourceKey(item.resource) === selected),
    ),
    current = media[index];
  const currentKey = current ? resourceKey(current.resource) : '';
  const issue =
    current &&
    ((loadError?.key === currentKey ? loadError.message : '') ||
      current.error ||
      (current.preview ? tr(canvasPreviewIssue(current.preview)) : ''));
  const download = async (resource: CanvasResource) => {
    if (resource.kind !== 'artifact' || downloading) return;
    setDownloading(true);
    try {
      await api.artifactDownload(resource.id);
      invalidateCanvasPreview(resource);
      setAttempt((value) => value + 1);
    } catch (error) {
      setLoadError({ key: resourceKey(resource), message: errorMessage(error) });
    } finally {
      setDownloading(false);
    }
  };
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
      <div className="canvas-preview-body">
        {loading ? (
          <p className="canvas-preview-empty" role="status">
            {tr('正在读取原件…')}
          </p>
        ) : !current ? (
          <p className="canvas-preview-empty">{tr('画布中没有可预览的图片、视频或音频。')}</p>
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
            {issue ? (
              <div className="canvas-preview-empty">
                <p role="alert">{issue}</p>
                {current.preview?.type === 'external' && current.resource.kind === 'artifact' ? (
                  <button disabled={downloading} onClick={() => void download(current.resource)}>
                    {downloading ? tr('正在下载原件…') : tr('下载原件并预览')}
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      invalidateCanvasPreview(current.resource);
                      setAttempt((value) => value + 1);
                    }}
                  >
                    {tr('重试加载')}
                  </button>
                )}
              </div>
            ) : current.preview?.type === 'audio' ? (
              <audio
                key={currentKey + attempt}
                src={current.preview.content}
                controls
                autoPlay
                onError={() =>
                  setLoadError({ key: currentKey, message: tr('媒体加载失败，请重试读取原件。') })
                }
              />
            ) : current.preview?.type === 'video' ? (
              <video
                key={currentKey + attempt}
                className="canvas-media-lightbox"
                src={current.preview.content}
                controls
                autoPlay
                onError={() =>
                  setLoadError({ key: currentKey, message: tr('媒体加载失败，请重试读取原件。') })
                }
              />
            ) : (
              <img
                key={currentKey + attempt}
                className="canvas-media-lightbox"
                src={current.preview?.content}
                alt={current.title}
                onError={() =>
                  setLoadError({ key: currentKey, message: tr('媒体加载失败，请重试读取原件。') })
                }
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
                    {item.preview?.type === 'image' && item.preview.content ? (
                      <img src={item.preview.content} alt="" />
                    ) : (
                      <span>
                        {item.error || canvasPreviewIssue(item.preview ?? { type: 'file' })
                          ? tr('预览不可用')
                          : item.preview?.type === 'audio'
                            ? tr('音频')
                            : tr('视频')}{' '}
                        {i + 1}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>,
    document.body,
  );
}
