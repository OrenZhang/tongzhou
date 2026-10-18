import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Link, RefreshCw, Unlink } from 'lucide-react';
import { t as tr } from '../../shared/i18n';
import type { CanvasNode, CanvasResource } from '../../shared/canvas';
import type { Snapshot, TongzhouAPI } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';
import { CanvasSourcePicker } from './CanvasSourcePicker';

/** Sources are loaded into the same editable text used by preview and execution. */
export function CanvasTextSource({
  api,
  data,
  node,
  sessionId,
  patch,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  node: CanvasNode;
  sessionId?: string;
  patch(value: Partial<CanvasNode>): void;
}) {
  const [picker, setPicker] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [url, setUrl] = useState(node.textSource?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const lock = useRef(false);
  const currentText = useRef(node.text);
  const latestPatch = useRef(patch);
  latestPatch.current = patch;
  currentText.current = node.text;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const load = async (source: { title: string; resource: CanvasResource } | { url: string }) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const original = currentText.current;
    try {
      const result =
        'url' in source
          ? await api.canvasImportTextUrl(source.url)
          : {
              ...(await api.canvasReadTextSource(source.resource)),
              title: source.title,
              url: undefined,
            };
      if (!active.current) return;
      if (currentText.current !== original)
        throw new Error(tr('正文已在读取期间修改，请重新载入来源'));
      latestPatch.current({
        text: result.text,
        resource: result.resource,
        textSource: { title: result.title, url: result.url },
      });
      setShowUrl(false);
      setPicker(false);
    } catch (e) {
      if (active.current) setError(errorMessage(e));
      throw e;
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <div className="canvas-text-source">
      <span className="canvas-text-source-label">{tr('内容来源')}</span>
      <div className="canvas-text-source-actions">
        <button
          disabled={busy}
          onClick={() => {
            setError('');
            setPicker(true);
          }}
        >
          <FolderOpen size={14} />
          {tr('关联资源 / 上传')}
        </button>
        <button disabled={busy} onClick={() => setShowUrl(!showUrl)}>
          <Link size={14} />
          {tr('外部地址')}
        </button>
      </div>
      {showUrl && (
        <form
          className="canvas-text-source-url"
          onSubmit={(e) => {
            e.preventDefault();
            void load({ url: url.trim() }).catch(() => {});
          }}
        >
          <input
            type="url"
            required
            aria-label={tr('外部内容地址')}
            placeholder="https://example.com/page.html"
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button disabled={busy || !url.trim()} type="submit">
            {busy ? tr('正在读取…') : tr('载入')}
          </button>
        </form>
      )}
      {node.textSource && (
        <div className="canvas-text-source-current">
          <span title={node.textSource.url ?? node.textSource.title}>{node.textSource.title}</span>
          <button
            title={tr('重新载入来源（覆盖当前正文）')}
            aria-label={tr('重新载入来源（覆盖当前正文）')}
            disabled={busy}
            onClick={() => {
              const source = node.textSource?.url
                ? { url: node.textSource.url }
                : node.resource
                  ? { title: node.textSource!.title, resource: node.resource }
                  : undefined;
              if (source) void load(source).catch(() => {});
            }}
          >
            <RefreshCw size={14} />
          </button>
          <button
            title={tr('解除关联，保留正文')}
            aria-label={tr('解除关联，保留正文')}
            disabled={busy}
            onClick={() => patch({ resource: undefined, textSource: undefined })}
          >
            <Unlink size={14} />
          </button>
        </div>
      )}
      <small>{tr('载入后可编辑正文；修改仅保存到此节点，不改动原件。')}</small>
      {error && !picker && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {picker &&
        createPortal(
          <CanvasSourcePicker
            api={api}
            data={data}
            sessionId={sessionId}
            onClose={() => {
              if (!lock.current) setPicker(false);
            }}
            onSelect={(title, resource) => load({ title, resource })}
          />,
          document.body,
        )}
    </div>
  );
}
