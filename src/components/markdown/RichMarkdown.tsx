import {
  Children,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';
import { WorkspaceFileContext } from '../../features/workspace/WorkspaceFileContext';
import { projectFileReference } from '../../shared/file-reference';
import { Check, Code2, Copy, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Root, RootContent } from 'hast';
import { highlight } from './highlight';
import { renderDiagram } from './diagram';
import { Modal } from '../components';
import { remarkKnowledgeLinks } from '../../shared/knowledge-links';
import 'katex/dist/katex.min.css';

function plain(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? plain(child.props.children)
          : '',
    )
    .join('');
}
function tokens(nodes: RootContent[]): ReactNode {
  return nodes.map((node, i) =>
    node.type === 'text' ? (
      node.value
    ) : node.type === 'element' ? (
      <span key={i} className={(node.properties.className as string[] | undefined)?.join(' ')}>
        {tokens(node.children)}
      </span>
    ) : null,
  );
}
function CopyCode({ text }: { text: string }) {
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(''), 1800);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <button
      type="button"
      aria-label="复制代码"
      title={status || '复制代码'}
      onClick={() => {
        void window.tongzhou.copyText(text).then(
          () => setStatus('已复制'),
          () => setStatus('复制失败'),
        );
      }}
    >
      {status === '已复制' ? <Check size={14} /> : <Copy size={14} />}
      <span aria-live="polite">{status || '复制'}</span>
    </button>
  );
}
const CodeBlock = memo(function CodeBlock({ text, language }: { text: string; language: string }) {
  const [result, setResult] = useState<{ text: string; tree?: Root }>();
  const [wrap, setWrap] = useState(false);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void highlight(text, language).then((tree) => {
        if (live) setResult({ text, tree });
      });
    }, 100);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, language]);
  return (
    <section className="code-block" aria-label={language ? language + ' 代码' : '代码'}>
      <div className="code-toolbar">
        <span>{language || '纯文本'}</span>
        <div>
          <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            换行
          </button>
          <CopyCode text={text} />
        </div>
      </div>
      <pre className={wrap ? 'code-wrap' : ''}>
        <code>{result?.text === text && result.tree ? tokens(result.tree.children) : text}</code>
      </pre>
    </section>
  );
});
function useDark() {
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.dataset.theme === 'dark'),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}
const Diagram = memo(function Diagram({ text, pending }: { text: string; pending: boolean }) {
  const dark = useDark();
  const [source, setSource] = useState(false),
    [expanded, setExpanded] = useState(false),
    [zoom, setZoom] = useState(1);
  const [result, setResult] = useState<{
    text: string;
    dark: boolean;
    url?: string;
    width?: number;
    error?: string;
  }>();
  useEffect(() => {
    if (pending) return;
    let live = true;
    const timer = setTimeout(() => {
      void renderDiagram(text, dark).then(
        (image) => {
          if (live) setResult({ text, dark, ...image });
        },
        () => {
          if (live) setResult({ text, dark, error: '图表尚未完整或语法不正确，可以查看源码。' });
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, dark, pending]);
  const current = result?.text === text && result.dark === dark ? result : undefined;
  const drawing = (
    <img
      className="diagram-image"
      src={current?.url}
      alt="Mermaid 图表"
      style={{
        width: current?.width ? current.width * zoom : undefined,
        maxWidth: zoom === 1 ? '100%' : 'none',
      }}
    />
  );
  const controls = (
    <>
      <button
        type="button"
        aria-label="缩小图表"
        disabled={zoom <= 0.5}
        onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
      >
        <ZoomOut size={14} />
      </button>
      <button type="button" title="重置缩放" onClick={() => setZoom(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        aria-label="放大图表"
        disabled={zoom >= 3}
        onClick={() => setZoom(Math.min(3, zoom + 0.25))}
      >
        <ZoomIn size={14} />
      </button>
    </>
  );
  return (
    <section className="diagram-block" aria-label="Mermaid 图表内容">
      <div className="code-toolbar">
        <span>Mermaid</span>
        <div>
          {current?.url && !source && controls}
          <button type="button" aria-pressed={source} onClick={() => setSource(!source)}>
            <Code2 size={14} />
            {source ? '图表' : '源码'}
          </button>
          <CopyCode text={text} />
          {current?.url && (
            <button type="button" aria-label="展开图表" onClick={() => setExpanded(true)}>
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      </div>
      {source || pending || current?.error ? (
        <>
          <p className="diagram-status">{pending ? '图表生成中…' : current?.error}</p>
          <CodeBlock text={text} language="mermaid" />
        </>
      ) : current?.url ? (
        <div className="diagram-canvas">{drawing}</div>
      ) : (
        <p className="diagram-status" role="status">
          正在绘制图表…
        </p>
      )}
      {expanded && current?.url && (
        <Modal title="图表预览" wide onClose={() => setExpanded(false)}>
          <div className="code-toolbar">
            {controls}
            <CopyCode text={text} />
          </div>
          <div className="diagram-canvas expanded">{drawing}</div>
        </Modal>
      )}
    </section>
  );
});
export function MarkdownLink({
  href,
  id,
  children,
}: {
  href?: string;
  id?: string;
  children: ReactNode;
}) {
  const [error, setError] = useState('');
  const files = useContext(WorkspaceFileContext);
  const reference = files && href ? projectFileReference(href, files.root) : undefined;
  if (reference)
    return (
      <button
        className="markdown-file-link"
        title={`查看 ${reference.path}`}
        onClick={() => files!.open(reference.path, reference.line)}
      >
        {children}
      </button>
    );
  if (!href || !/^(https?:\/\/|#)/i.test(href)) return <span>{children}</span>;
  return (
    <>
      <a
        id={id}
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault();
          if (href.startsWith('#'))
            document.getElementById(href.slice(1))?.scrollIntoView({ block: 'nearest' });
          else void window.tongzhou.openExternalLink(href).catch(() => setError('无法打开链接'));
        }}
      >
        {children}
      </a>
      {error && <small role="status">{error}</small>}
    </>
  );
}
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  onKnowledgeLink,
}: {
  text: string;
  streaming?: boolean;
  onKnowledgeLink?: (target: string) => void;
}) {
  const id = useId().replace(/[^a-z0-9]/gi, '');
  const files = useContext(WorkspaceFileContext);
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        urlTransform={(url) =>
          files && projectFileReference(url, files.root) ? url : defaultUrlTransform(url)
        }
        remarkPlugins={
          onKnowledgeLink ? [remarkGfm, remarkMath, remarkKnowledgeLinks] : [remarkGfm, remarkMath]
        }
        remarkRehypeOptions={{
          clobberPrefix: 'md-' + id + '-',
          footnoteLabel: '注释',
          footnoteBackLabel: '返回正文',
        }}
        rehypePlugins={[
          [rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false, maxExpand: 1000 }],
        ]}
        components={{
          a: ({ href, id, children }) =>
            onKnowledgeLink && href?.startsWith('#knowledge:') ? (
              <button
                className="knowledge-inline-link"
                onClick={() => onKnowledgeLink(decodeURIComponent(href.slice(11)))}
              >
                {children}
              </button>
            ) : (
              <MarkdownLink href={href} id={id}>
                {children}
              </MarkdownLink>
            ),
          img: ({ src, alt }) => (
            <MarkdownLink href={typeof src === 'string' ? src : undefined}>
              [图片：{alt || '查看图片'}]
            </MarkdownLink>
          ),
          pre: ({ children, node }) => {
            const child = Children.toArray(children).find((c) => isValidElement(c));
            const language = isValidElement<{ className?: string }>(child)
              ? (/language-([^\s]+)/.exec(child.props.className ?? '')?.[1]?.toLowerCase() ?? '')
              : '';
            const value = plain(children);
            if (language === 'mermaid') {
              const raw = text
                .slice(node?.position?.start.offset, node?.position?.end.offset)
                .trimEnd();
              const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
              const last = raw.split('\n').at(-1)?.trim() ?? '';
              const closed =
                !!fence && last.length >= fence.length && [...last].every((c) => c === fence[0]);
              return <Diagram text={value} pending={streaming && !closed} />;
            }
            return <CodeBlock text={value} language={language} />;
          },
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
