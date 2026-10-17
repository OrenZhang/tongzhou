import { useEffect, useRef, useState } from 'react';
import { FolderOutput, Maximize2 } from 'lucide-react';
import { CanvasPreview, resourceKey, type CanvasPreviewItem } from './CanvasPreview';
import type { Canvas, CanvasNode, CanvasNodeRun, CanvasResource } from '../../shared/canvas';
import { canvasNodeKinds } from '../../shared/canvas';
import type { TongzhouAPI } from '../../shared/types';

export function ResourceThumbnail({
  api,
  resource,
  revision,
  onPreview,
  showText = false,
}: {
  api: TongzhouAPI;
  resource?: CanvasResource;
  revision?: string;
  onPreview?(): void;
  showText?: boolean;
}) {
  const [image, setImage] = useState(''),
    [caption, setCaption] = useState(''),
    [video, setVideo] = useState(false);
  useEffect(() => {
    let current = true;
    setImage('');
    setCaption('');
    setVideo(false);
    if (resource && (resource.kind === 'content' || resource.kind === 'artifact'))
      void api
        .canvasResourcePreview(resource)
        .then((p) => {
          if (current && showText && p.type === 'text') setCaption(p.content ?? '');
          if (current && (p.type === 'image' || p.type === 'video')) {
            setImage(p.content ?? '');
            setVideo(p.type === 'video');
          }
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, JSON.stringify(resource), revision, showText]);
  const media = video ? (
    <video src={image} muted preload="metadata" playsInline aria-label="视频预览" />
  ) : (
    <img src={image} alt="资源预览" draggable={false} />
  );
  return !image ? (
    caption ? (
      <p className="canvas-resource-caption">{caption}</p>
    ) : null
  ) : onPreview ? (
    <button
      className="canvas-thumbnail"
      aria-label="预览图片或视频"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onPreview}
    >
      {media}
      <span>预览</span>
    </button>
  ) : (
    media
  );
}

/** A controlled surface: layout, manual edits and agent edits share Canvas data. */
export function CanvasBoard({
  api,
  canvas,
  steps,
  onChange,
  onSelect,
  onConfigure,
}: {
  api: TongzhouAPI;
  canvas: Canvas;
  steps: Record<string, CanvasNodeRun>;
  onChange(c: Canvas, record?: boolean): void;
  onSelect(ids: string[]): void;
  onConfigure(id: string): void;
}) {
  const board = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ items: CanvasPreviewItem[]; initial?: string }>();
  const gallery = () =>
    canvas.nodes.flatMap((n) => {
      const step = steps[n.id];
      const refs =
        (n.resource ? [n.resource] : undefined) ??
        step?.generation?.flatMap((item) => item.resources.filter((r) => r.kind === 'artifact')) ??
        step?.output?.resources.filter((r) => r.kind === 'artifact') ??
        [];
      return refs
        .filter((r) => r.kind === 'content' || r.kind === 'artifact')
        .map((resource, i) => ({
          resource,
          title: n.title + (refs.length > 1 ? ` · ${i + 1}` : ''),
        }));
    });
  const openPreview = (resource?: CanvasResource) =>
    setPreview({ items: gallery(), initial: resource ? resourceKey(resource) : undefined });
  const gesture = useRef<
    | {
        x: number;
        y: number;
        positions?: CanvasNode[];
        resize?: CanvasNode;
        viewport: Canvas['viewport'];
        moved: boolean;
      }
    | undefined
  >(undefined);
  const latest = useRef(canvas);
  latest.current = canvas;
  const select = (node: CanvasNode, extend: boolean) => {
    const previous = latest.current.selection;
    const next = extend
      ? previous.includes(node.id)
        ? previous.filter((v) => v !== node.id)
        : [...previous, node.id]
      : previous.includes(node.id)
        ? previous
        : [node.id];
    onSelect(next);
    return next;
  };
  const zoom = (delta: number, cx: number, cy: number) => {
    const c = latest.current,
      v = c.viewport,
      k = Math.max(0.15, Math.min(3, v.zoom * delta));
    onChange({
      ...c,
      viewport: { x: cx - ((cx - v.x) * k) / v.zoom, y: cy - ((cy - v.y) * k) / v.zoom, zoom: k },
    });
  };
  useEffect(() => {
    const element = board.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = element.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        zoom(Math.exp(-e.deltaY * 0.005), e.clientX - rect.left, e.clientY - rect.top);
      else {
        const c = latest.current;
        onChange({
          ...c,
          viewport: { ...c.viewport, x: c.viewport.x - e.deltaX, y: c.viewport.y - e.deltaY },
        });
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [onChange]);
  const statusLabels: Record<string, string> = {
    pending: '等待',
    running: '运行中',
    completed: '完成',
    cached: '已复用',
    failed: '失败',
    cancelled: '未执行',
  };
  return (
    <div
      className="canvas-board"
      ref={board}
      tabIndex={0}
      aria-label="通用画布，拖动空白处平移，按住 Command 或 Ctrl 滚轮缩放"
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget || e.button !== 0) return;
        board.current?.setPointerCapture(e.pointerId);
        gesture.current = { x: e.clientX, y: e.clientY, viewport: canvas.viewport, moved: false };
        onSelect([]);
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!g) return;
        if ((e.buttons & 1) === 0) {
          gesture.current = undefined;
          return;
        }
        const dx = e.clientX - g.x,
          dy = e.clientY - g.y;
        if (Math.abs(dx) + Math.abs(dy) < 3 && !g.moved) return;
        const firstMove = !g.moved;
        g.moved = true;
        const c = latest.current;
        if (g.resize) {
          onChange(
            {
              ...c,
              nodes: c.nodes.map((n) =>
                n.id === g.resize!.id
                  ? {
                      ...n,
                      width: Math.round(
                        Math.min(
                          1600,
                          Math.max(160, (g.resize!.width ?? 240) + dx / g.viewport.zoom),
                        ),
                      ),
                      height: Math.round(
                        Math.min(
                          1600,
                          Math.max(120, (g.resize!.height ?? 180) + dy / g.viewport.zoom),
                        ),
                      ),
                    }
                  : n,
              ),
            },
            firstMove,
          );
        } else if (g.positions) {
          const positions = new Map(g.positions.map((n) => [n.id, n]));
          onChange(
            {
              ...c,
              nodes: c.nodes.map((n) => {
                const p = positions.get(n.id);
                return p
                  ? { ...n, x: p.x + dx / g.viewport.zoom, y: p.y + dy / g.viewport.zoom }
                  : n;
              }),
            },
            firstMove,
          );
        } else
          onChange(
            {
              ...c,
              viewport: { ...g.viewport, x: g.viewport.x + dx, y: g.viewport.y + dy },
            },
            firstMove,
          );
      }}
      onPointerUp={() => {
        gesture.current = undefined;
      }}
      onPointerCancel={() => {
        gesture.current = undefined;
      }}
      onLostPointerCapture={() => {
        gesture.current = undefined;
      }}
    >
      <div
        className="canvas-world"
        style={{
          transform: `translate(${canvas.viewport.x}px,${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
        }}
      >
        <svg className="canvas-edges" aria-hidden="true">
          {canvas.edges.map((edge) => {
            const a = canvas.nodes.find((n) => n.id === edge.from),
              b = canvas.nodes.find((n) => n.id === edge.to);
            if (!a || !b) return null;
            const x = a.x + (a.width ?? 240),
              y = a.y + (a.height ?? 180) / 2,
              tx = b.x,
              ty = b.y + (b.height ?? 180) / 2;
            return (
              <g key={edge.id}>
                <path
                  className={edge.kind}
                  d={`M${x} ${y} C${x + 90} ${y},${tx - 90} ${ty},${tx} ${ty}`}
                />
                <circle cx={tx} cy={ty} r="4" />
              </g>
            );
          })}
        </svg>
        {canvas.nodes.map((node) => {
          const step = steps[node.id],
            output = step?.output;
          const preview = node.resource ?? output?.resources.find((r) => r.kind === 'artifact');
          return (
            <article
              key={node.id}
              className={`canvas-node ${canvas.selection.includes(node.id) ? 'selected' : ''} ${step?.status ?? ''} ${['image', 'video'].includes(node.kind) ? 'media-node' : ''}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.width ?? 240,
                height: node.height ?? 180,
              }}
              aria-label={`${node.title}，${canvasNodeKinds[node.kind]}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button !== 0) return;
                const ids = select(node, e.shiftKey);
                board.current?.setPointerCapture(e.pointerId);
                gesture.current = {
                  x: e.clientX,
                  y: e.clientY,
                  viewport: canvas.viewport,
                  positions: canvas.nodes.filter((n) => ids.includes(n.id)),
                  moved: false,
                };
              }}
            >
              <header>
                <small>{canvasNodeKinds[node.kind]}</small>
                <span className="canvas-node-status">
                  {step ? statusLabels[step.status] : ''}
                  {step?.generation
                    ? ` ${step.generation.filter((i) => i.status === 'completed').length}/${step.generation.length}`
                    : ''}
                </span>
              </header>
              <strong>{node.title}</strong>
              {(['image', 'video'].includes(node.kind) || node.resource) && (
                <button
                  className="canvas-node-save"
                  aria-label={`${node.title}保存位置`}
                  title="选择保存位置，默认作品"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onConfigure(node.id)}
                >
                  <FolderOutput size={12} />
                  {node.media?.destination?.kind === 'directory'
                    ? '本地目录'
                    : node.media?.destination?.kind === 'content'
                      ? '内容库'
                      : '作品'}
                </button>
              )}
              {step?.generation?.length ? (
                <div className="canvas-node-grid">
                  {step.generation.slice(0, 4).map((item) => (
                    <div key={item.index}>
                      <ResourceThumbnail
                        api={api}
                        resource={item.resources[0]}
                        revision={item.status + item.phase}
                        onPreview={() => openPreview(item.resources[0])}
                      />
                      <small>
                        {item.index + 1} ·{' '}
                        {item.status === 'completed'
                          ? '完成'
                          : item.status === 'failed'
                            ? '失败'
                            : item.status === 'running'
                              ? '生成中'
                              : '等待'}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <ResourceThumbnail
                  api={api}
                  resource={preview}
                  showText={!!node.resource}
                  onPreview={() => openPreview(preview)}
                />
              )}
              <p>
                {step?.error ||
                  output?.text ||
                  node.text ||
                  (node.resource
                    ? `${node.resource.kind} · ${'version' in node.resource ? 'v' + node.resource.version : '引用原件'}`
                    : '选择节点以配置')}
              </p>
              <span className="canvas-node-port input" />
              <span className="canvas-node-port output" />
              <button
                className="canvas-node-resize"
                aria-label={`调整${node.title}大小`}
                title="拖动调整大小；方向键微调"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.button !== 0) return;
                  select(node, false);
                  board.current?.setPointerCapture(e.pointerId);
                  gesture.current = {
                    x: e.clientX,
                    y: e.clientY,
                    viewport: canvas.viewport,
                    resize: node,
                    moved: false,
                  };
                }}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const size = e.shiftKey ? 24 : 8;
                  onChange({
                    ...canvas,
                    nodes: canvas.nodes.map((n) =>
                      n.id !== node.id
                        ? n
                        : {
                            ...n,
                            width: Math.min(
                              1600,
                              Math.max(
                                160,
                                (n.width ?? 240) +
                                  (e.key === 'ArrowLeft'
                                    ? -size
                                    : e.key === 'ArrowRight'
                                      ? size
                                      : 0),
                              ),
                            ),
                            height: Math.min(
                              1600,
                              Math.max(
                                120,
                                (n.height ?? 180) +
                                  (e.key === 'ArrowUp' ? -size : e.key === 'ArrowDown' ? size : 0),
                              ),
                            ),
                          },
                    ),
                  });
                }}
              >
                <Maximize2 size={11} />
              </button>
            </article>
          );
        })}
      </div>
      {!canvas.nodes.length && (
        <div className="canvas-empty">
          添加文本、资源或能力节点
          <br />
          <small>连线组织上下文与执行依赖</small>
        </div>
      )}
      <button className="canvas-gallery-open" onClick={() => openPreview()}>
        图片预览
      </button>
      {preview && (
        <CanvasPreview
          api={api}
          items={preview.items}
          initial={preview.initial}
          storageKey={'tongzhou.canvas.preview.' + canvas.id}
          onClose={() => setPreview(undefined)}
        />
      )}
      <div className="canvas-zoom">
        <button
          onClick={() => {
            if (!canvas.nodes.length || !board.current) return;
            const minX = Math.min(...canvas.nodes.map((n) => n.x)),
              minY = Math.min(...canvas.nodes.map((n) => n.y));
            const width = Math.max(...canvas.nodes.map((n) => n.x + (n.width ?? 240))) - minX,
              height = Math.max(...canvas.nodes.map((n) => n.y + (n.height ?? 180))) - minY;
            const zoom = Math.max(
              0.15,
              Math.min(
                1.4,
                (board.current.clientWidth - 60) / width,
                (board.current.clientHeight - 60) / height,
              ),
            );
            onChange({
              ...canvas,
              viewport: {
                zoom,
                x: (board.current.clientWidth - width * zoom) / 2 - minX * zoom,
                y: (board.current.clientHeight - height * zoom) / 2 - minY * zoom,
              },
            });
          }}
        >
          适应
        </button>
        <button aria-label="缩小画布" onClick={() => zoom(0.8, 300, 200)}>
          −
        </button>
        <button onClick={() => onChange({ ...canvas, viewport: { x: 40, y: 40, zoom: 1 } })}>
          {Math.round(canvas.viewport.zoom * 100)}%
        </button>
        <button aria-label="放大画布" onClick={() => zoom(1.25, 300, 200)}>
          ＋
        </button>
      </div>
    </div>
  );
}
