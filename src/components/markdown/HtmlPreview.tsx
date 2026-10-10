import { useEffect, useRef, useState } from 'react';
import { Code2, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import './html-preview.css';

/** No application commands are exposed to generated UI. All interaction stays inside the frame. */
export function HtmlPreview({ text, pending = false }: { text: string; pending?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [height, setHeight] = useState(320);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const tooLarge = text.length > 1000000;
  useEffect(() => {
    setError('');
    setLoaded(false);
    setHeight(320);
    if (pending || tooLarge) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (data?.type === 'tongzhou:preview:ready') {
        frame.current?.contentWindow?.postMessage(
          {
            type: 'tongzhou:preview:init',
            html: text,
            dark: document.documentElement.dataset.theme === 'dark',
          },
          '*',
        );
      } else if (data?.type === 'tongzhou:preview:height' && Number.isFinite(data.value)) {
        setHeight(Math.min(1200, Math.max(120, data.value)));
      } else if (data?.type === 'tongzhou:preview:loaded') setLoaded(true);
      else if (data?.type === 'tongzhou:preview:error') setError('交互脚本运行出错，请查看源码。');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [text, pending, tooLarge, revision]);
  return (
    <section className={`html-preview${expanded ? ' is-expanded' : ''}`} aria-label="HTML 交互预览">
      <div className="code-toolbar">
        <span>HTML · 交互预览</span>
        <div>
          <button type="button" aria-pressed={source} onClick={() => setSource(!source)}>
            <Code2 size={14} />
            {source ? '预览' : '源码'}
          </button>
          <button
            type="button"
            aria-label="重新运行预览"
            disabled={pending || tooLarge}
            onClick={() => setRevision(revision + 1)}
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            aria-label={expanded ? '收起预览' : '展开预览'}
            aria-pressed={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
      {(pending || tooLarge || error) && (
        <p className="diagram-status" role="status">
          {pending ? '交互界面生成中…' : tooLarge ? '内容超过预览上限，请查看源码。' : error}
        </p>
      )}
      {source || tooLarge ? (
        <pre className="html-preview-source">
          <code>{text}</code>
        </pre>
      ) : null}
      {!pending && !tooLarge && (
        <iframe
          key={text + revision}
          ref={frame}
          src="./interactive-preview.html"
          title="HTML 交互内容"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          hidden={source}
          data-loaded={loaded}
          style={{ height: expanded ? Math.max(height, 640) : Math.min(height, 620) }}
        />
      )}
    </section>
  );
}
