import { Component, type ComponentType, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import type { CanvasNode, CanvasNodePluginDefinition, CanvasOutput } from '../../shared/canvas';
import type { TongzhouAPI } from '../../shared/types';
import { CanvasPanorama } from './CanvasPanorama';

export interface CanvasRendererProps {
  api: TongzhouAPI;
  node: CanvasNode;
  output?: CanvasOutput;
  patch(value: Partial<CanvasNode>): void;
}
const renderers = new Map<string, ComponentType<CanvasRendererProps>>();
/** Register from a bundled frontend extension; dispose when the extension unloads. */
export function registerCanvasRenderer(id: string, renderer: ComponentType<CanvasRendererProps>) {
  if (renderers.has(id)) throw new Error('节点预览已注册：' + id);
  renderers.set(id, renderer);
  return () => {
    if (renderers.get(id) === renderer) renderers.delete(id);
  };
}
export function canvasPreviewDocument(text: string, svg = false) {
  const content = DOMPurify.sanitize(text, {
    FORCE_BODY: true,
    ADD_TAGS: ['style'],
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'base',
      'meta',
      'form',
      'link',
      'audio',
      'video',
    ],
    FORBID_ATTR: ['href', 'xlink:href', 'action', 'formaction', 'srcset'],
  });
  // Opaque-origin frame: no scripts, forms, navigation, remote resources or host bridge.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:8px;overflow-wrap:anywhere}${svg ? 'html,body{height:100%;margin:0}svg{display:block;width:100%;height:100%}' : ''}</style></head><body>${content}</body></html>`;
}
registerCanvasRenderer('markdown', ({ node }) => (
  <div className="canvas-markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children }) => <span>{children}</span>,
        img: ({ alt }) => <span>{alt || '图片'}</span>,
      }}
    >
      {node.text ?? ''}
    </ReactMarkdown>
  </div>
));
for (const id of ['svg', 'html'])
  registerCanvasRenderer(id, ({ node }) => (
    <iframe
      title={id === 'svg' ? 'SVG 预览' : 'HTML 预览'}
      tabIndex={-1}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={canvasPreviewDocument(node.text ?? '', id === 'svg')}
    />
  ));
registerCanvasRenderer('sticky-note', ({ node }) => (
  <div
    className={`canvas-sticky-note note-${['yellow', 'pink', 'blue', 'green'].includes(String(node.config?.color)) ? node.config?.color : 'yellow'}`}
  >
    {node.text || '空白便签'}
  </div>
));
registerCanvasRenderer('panorama', CanvasPanorama);

class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">节点预览失败，请检查节点内容</p>
    ) : (
      this.props.children
    );
  }
}
export function CanvasNodeView({
  definition,
  onSelect,
  ...props
}: CanvasRendererProps & {
  definition: CanvasNodePluginDefinition;
  onSelect(extend: boolean): void;
}) {
  const Renderer = renderers.get(definition.view?.renderer ?? '');
  return (
    <div
      className="canvas-plugin-view"
      onPointerDownCapture={(e) => {
        if (e.button === 0) onSelect(e.shiftKey);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <RendererBoundary key={props.node.id + ':' + definition.view?.renderer}>
        {Renderer ? (
          <Renderer {...props} />
        ) : (
          <p role="alert">此插件的预览组件未安装：{definition.view?.renderer}</p>
        )}
      </RendererBoundary>
    </div>
  );
}
