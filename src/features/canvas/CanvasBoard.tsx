import { uiCanvasPorts as canvasPorts } from './port-labels';
import { t as tr, localize as localized } from '../../shared/i18n';
import { CanvasMinimap } from './CanvasMinimap';
import { canvasNodeDragType } from './CanvasNodePalette';
import { CanvasPortMenu, type CanvasPortAnchor } from './CanvasPortMenu';
import { connectCanvasPorts } from '../../shared/canvas-ports';
import { CanvasNodeView } from './node-renderers';
import { CanvasMediaNode } from './CanvasMediaNode';
import type { CanvasNodePluginDefinition } from '../../shared/canvas';
import { appendConnectedCanvasNode, nodeBounds } from '../../shared/canvas-editing';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOutput, MoveDiagonal2, Settings2, Trash2 } from 'lucide-react';
import { CanvasPreview, resourceKey, type CanvasPreviewItem } from './CanvasPreview';
import type { Canvas, CanvasNode, CanvasNodeRun, CanvasResource } from '../../shared/canvas';
import { canvasNodeKinds as raw_canvasNodeKinds } from '../../shared/canvas';
import type { Snapshot, TongzhouAPI } from '../../shared/types';

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
    [video, setVideo] = useState(false),
    [audio, setAudio] = useState(false);
  useEffect(() => {
    let current = true;
    setImage('');
    setCaption('');
    setVideo(false);
    setAudio(false);
    if (resource && (resource.kind === 'content' || resource.kind === 'artifact'))
      void api
        .canvasResourcePreview(resource)
        .then((p) => {
          if (current && showText && p.type === 'text') setCaption(p.content ?? '');
          if (current && (p.type === 'image' || p.type === 'video' || p.type === 'audio')) {
            setImage(p.content ?? '');
            setVideo(p.type === 'video');
            setAudio(p.type === 'audio');
          }
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, JSON.stringify(resource), revision, showText]);
  if (audio && image)
    return (
      <audio
        src={image}
        controls
        preload="metadata"
        aria-label={tr('音频预览')}
        onPointerDown={(e) => e.stopPropagation()}
      />
    );
  const media = video ? (
    <video src={image} muted preload="metadata" playsInline aria-label={tr('视频预览')} />
  ) : (
    <img src={image} alt={tr('资源预览')} draggable={false} />
  );
  return !image ? (
    caption ? (
      <p className="canvas-resource-caption">{caption}</p>
    ) : null
  ) : onPreview ? (
    <button
      className="canvas-thumbnail"
      aria-label={tr('预览媒体')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onPreview}
    >
      {media}
      <span>{tr('预览')}</span>
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
  onRemove,
  onAddNode,
  plugins = [],
  onError,
  mediaControls,
}: {
  api: TongzhouAPI;
  canvas: Canvas;
  steps: Record<string, CanvasNodeRun>;
  onChange(c: Canvas, record?: boolean): void;
  onSelect(ids: string[]): void;
  onConfigure(id: string): void;
  onRemove(ids: string[]): void;
  onAddNode?(pluginId: string, position: { x: number; y: number }): void;
  plugins?: CanvasNodePluginDefinition[];
  onError(error: unknown): void;
  mediaControls?: {
    data: Snapshot;
    disabled: boolean;
    hideComposer?: boolean;
    composerTarget: HTMLElement | null;
    edit(): void;
    dismiss(): void;
    sourceCanvas?: Canvas;
    previousSteps?: Record<string, CanvasNodeRun>;
    executionIssue?: string;
    generate(nodeId: string): void;
    history(nodeId: string): void;
    retry(
      nodeId: string,
      index?: number,
      action?: NonNullable<import('../../shared/canvas').CanvasExecute['regenerate']>['action'],
    ): void;
  };
}) {
  const board = useRef<HTMLDivElement>(null);
  const [portMenu, setPortMenu] = useState<CanvasPortAnchor>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const linkDrag = useRef<{ x: number; y: number; moved: boolean }>(undefined);
  const keepPortMenu = useCallback(() => {
    clearTimeout(leaveTimer.current);
  }, []);
  const closePortMenu = useCallback(() => {
    clearTimeout(hoverTimer.current);
    clearTimeout(leaveTimer.current);
    setPortMenu(undefined);
  }, []);
  const leavePort = () => {
    clearTimeout(hoverTimer.current);
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setPortMenu(undefined), 250);
  };
  const portAnchor = (nodeId: string, portId: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return { nodeId, portId, x: rect.right + 6, y: rect.top - 16 };
  };
  useEffect(() => {
    closePortMenu();
  }, [canvas.id, closePortMenu]);
  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current);
      clearTimeout(leaveTimer.current);
    },
    [],
  );
  const menu = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    ids: string[];
    nodeId: string;
  }>();
  useEffect(() => setContextMenu(undefined), [canvas.id]);
  useEffect(() => {
    if (!contextMenu) return;
    menu.current?.querySelector('button')?.focus();
    const close = () => setContextMenu(undefined);
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);
  const [connecting, setConnecting] = useState<{
    nodeId: string;
    portId: string;
    x: number;
    y: number;
  }>();
  const definitionFor = (node: CanvasNode) =>
    plugins.find((p) => p.id === (node.pluginId ?? node.kind));
  const portY = (node: CanvasNode, direction: 'inputs' | 'outputs', id?: string) => {
    const ports = canvasPorts(node, definitionFor(node))[direction];
    const index = ports.findIndex((p) => p.id === id);
    return node.y + (node.height ?? 180) * (index < 0 ? 0.5 : (index + 1) / (ports.length + 1));
  };
  const finishConnection = (nodeId: string, portId: string) => {
    if (!connecting) return;
    try {
      onChange(
        connectCanvasPorts(
          latest.current,
          {
            id: crypto.randomUUID(),
            from: connecting.nodeId,
            to: nodeId,
            kind: 'dependency',
            fromPort: connecting.portId,
            toPort: portId,
          },
          plugins,
        ),
      );
    } catch (error) {
      onError(error);
    }
    setConnecting(undefined);
    closePortMenu();
  };
  useEffect(() => {
    const cancel = () => {
      setConnecting(undefined);
      linkDrag.current = undefined;
    };
    window.addEventListener('pointerup', cancel);
    return () => window.removeEventListener('pointerup', cancel);
  }, []);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number }>();
  useEffect(() => {
    const element = board.current!;
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
        marquee?: { x: number; y: number; selection: string[] };
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
    const grouped =
      !extend && node.group
        ? latest.current.nodes.filter((n) => n.group === node.group).map((n) => n.id)
        : next;
    onSelect(grouped);
    return grouped;
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
      if (
        (e.target as Element).closest(
          '.canvas-media-composer, .canvas-media-content textarea, .canvas-node-text',
        )
      )
        return;
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
    pending: tr('等待'),
    running: tr('运行中'),
    completed: tr('完成'),
    cached: tr('已复用'),
    failed: tr('失败'),
    cancelled: tr('未执行'),
  };
  return (
    <div
      className="canvas-board"
      ref={board}
      tabIndex={0}
      aria-label={tr('通用画布，拖动空白处平移，按住 Command 或 Ctrl 滚轮缩放')}
      onDragOver={(e) => {
        if (!onAddNode || !e.dataTransfer.types.includes(canvasNodeDragType)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!onAddNode || !e.dataTransfer.types.includes(canvasNodeDragType)) return;
        e.preventDefault();
        e.stopPropagation();
        const pluginId = e.dataTransfer.getData(canvasNodeDragType);
        if (!plugins.some((p) => p.id === pluginId)) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const viewport = latest.current.viewport;
        onAddNode(pluginId, {
          x: (e.clientX - rect.left - viewport.x) / viewport.zoom,
          y: (e.clientY - rect.top - viewport.y) / viewport.zoom,
        });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && connecting) {
          e.stopPropagation();
          setConnecting(undefined);
        }
      }}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget || e.button !== 0) return;
        board.current?.setPointerCapture(e.pointerId);
        gesture.current = { x: e.clientX, y: e.clientY, viewport: canvas.viewport, moved: false };
        if (e.shiftKey) {
          const rect = board.current!.getBoundingClientRect();
          gesture.current.marquee = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            selection: [...canvas.selection],
          };
        } else onSelect([]);
      }}
      onPointerMove={(e) => {
        if (connecting) {
          if (
            linkDrag.current &&
            Math.abs(e.clientX - linkDrag.current.x) + Math.abs(e.clientY - linkDrag.current.y) > 3
          )
            linkDrag.current.moved = true;
          const rect = board.current!.getBoundingClientRect(),
            v = canvas.viewport;
          setConnecting({
            ...connecting,
            x: (e.clientX - rect.left - v.x) / v.zoom,
            y: (e.clientY - rect.top - v.y) / v.zoom,
          });
          return;
        }
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
        if (g.marquee) {
          const r = {
            x: Math.min(g.marquee.x, g.marquee.x + dx),
            y: Math.min(g.marquee.y, g.marquee.y + dy),
            width: Math.abs(dx),
            height: Math.abs(dy),
          };
          setMarquee(r);
          const v = g.viewport;
          const ids = c.nodes
            .filter(
              (n) =>
                (n.x + (n.width ?? 240)) * v.zoom + v.x >= r.x &&
                n.x * v.zoom + v.x <= r.x + r.width &&
                (n.y + (n.height ?? 180)) * v.zoom + v.y >= r.y &&
                n.y * v.zoom + v.y <= r.y + r.height,
            )
            .map((n) => n.id);
          onChange({ ...c, selection: [...new Set([...g.marquee.selection, ...ids])] }, firstMove);
        } else if (g.resize) {
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
        setMarquee(undefined);
      }}
      onPointerCancel={() => {
        setConnecting(undefined);
        gesture.current = undefined;
        setMarquee(undefined);
      }}
      onLostPointerCapture={() => {
        gesture.current = undefined;
        setMarquee(undefined);
      }}
    >
      <div
        className="canvas-world"
        style={{
          transform: `translate(${canvas.viewport.x}px,${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
        }}
      >
        {[...new Set(canvas.nodes.flatMap((n) => (n.group ? [n.group] : [])))].map((group) => {
          const nodes = canvas.nodes.filter((n) => n.group === group),
            b = nodeBounds(nodes);
          return (
            <div
              className="canvas-group"
              key={group}
              style={{ left: b.x - 16, top: b.y - 36, width: b.width + 32, height: b.height + 52 }}
            >
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onSelect(nodes.map((n) => n.id))}
              >
                {group}
              </button>
            </div>
          );
        })}
        <svg className="canvas-edges" aria-hidden="true">
          {connecting &&
            (() => {
              const n = canvas.nodes.find((n) => n.id === connecting.nodeId);
              return n ? (
                <path
                  className="dependency pending"
                  d={`M${n.x + (n.width ?? 240)} ${portY(n, 'outputs', connecting.portId)} L${connecting.x} ${connecting.y}`}
                />
              ) : null;
            })()}
          {canvas.edges.map((edge) => {
            const a = canvas.nodes.find((n) => n.id === edge.from),
              b = canvas.nodes.find((n) => n.id === edge.to);
            if (!a || !b) return null;
            const x = a.x + (a.width ?? 240),
              y = portY(a, 'outputs', edge.fromPort),
              tx = b.x,
              ty = portY(b, 'inputs', edge.toPort);
            const bend = Math.max(24, Math.min(90, Math.abs(tx - x) / 2));
            return (
              <g key={edge.id}>
                <path
                  className={edge.kind}
                  d={`M${x} ${y} C${x + bend} ${y},${tx - bend} ${ty},${tx} ${ty}`}
                />
              </g>
            );
          })}
        </svg>
        {canvas.nodes.map((node) => {
          const definition = plugins.find((p) => p.id === (node.pluginId ?? node.kind));
          const typeLabel = tr(definition?.name ?? raw_canvasNodeKinds[node.kind]);
          const label =
            !node.title ||
            node.title === typeLabel ||
            node.title === definition?.name ||
            node.title === raw_canvasNodeKinds[node.kind]
              ? typeLabel
              : `${typeLabel} · ${node.title}`;
          const step = steps[node.id],
            output = step?.output;
          const preview = node.resource ?? output?.resources.find((r) => r.kind === 'artifact');
          const inlineMedia = !!mediaControls && (node.kind === 'image' || node.kind === 'video');
          return (
            <article
              key={node.id}
              className={`canvas-node ${canvas.selection.includes(node.id) ? 'selected' : ''} ${step?.status ?? ''} ${['image', 'video', 'audio'].includes(node.kind) ? 'media-node' : ''} ${inlineMedia ? 'inline-media-node' : ''}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.width ?? 240,
                height: node.height ?? 180,
              }}
              aria-label={`${node.title}，${definition?.view ? tr(definition.name) : canvasNodeKinds[node.kind]}`}
              onContextMenu={(e) => {
                if ((e.target as Element).closest('input,textarea,[contenteditable="true"]'))
                  return;
                e.preventDefault();
                e.stopPropagation();
                setConnecting(undefined);
                closePortMenu();
                const ids = latest.current.selection.includes(node.id)
                  ? latest.current.selection
                  : [node.id];
                if (!latest.current.selection.includes(node.id)) onSelect(ids);
                setContextMenu({
                  x: Math.max(8, Math.min(e.clientX, window.innerWidth - 208)),
                  y: Math.max(8, Math.min(e.clientY, window.innerHeight - 96)),
                  ids,
                  nodeId: node.id,
                });
              }}
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
                <small className="canvas-node-label" title={label}>
                  {label}
                </small>
                <span className="canvas-node-status">
                  {step ? statusLabels[step.status] : ''}
                  {step?.generation
                    ? ` ${step.generation.filter((i) => i.status === 'completed').length}/${step.generation.length}`
                    : ''}
                </span>
              </header>
              {inlineMedia && mediaControls && (
                <CanvasMediaNode
                  api={api}
                  data={mediaControls.data}
                  composerTarget={mediaControls.composerTarget}
                  canvas={canvas}
                  node={node}
                  step={step}
                  sourceNode={mediaControls.sourceCanvas?.nodes.find((n) => n.id === node.id)}
                  previousStep={mediaControls.previousSteps?.[node.id]}
                  steps={steps}
                  selected={
                    !mediaControls.hideComposer &&
                    canvas.selection.length === 1 &&
                    canvas.selection[0] === node.id
                  }
                  disabled={mediaControls.disabled}
                  executionIssue={mediaControls.executionIssue}
                  patch={(value, removeEdges = []) =>
                    onChange({
                      ...latest.current,
                      edges: latest.current.edges.filter((e) => !removeEdges.includes(e.id)),
                      nodes: latest.current.nodes.map((n) =>
                        n.id === node.id ? { ...n, ...value } : n,
                      ),
                    })
                  }
                  onSelect={() => {
                    onSelect([node.id]);
                    mediaControls.edit();
                  }}
                  onDismiss={mediaControls.dismiss}
                  onVideo={() => {
                    const video = plugins.find((p) => p.id === 'video');
                    if (!video) return;
                    try {
                      onChange(
                        appendConnectedCanvasNode(
                          latest.current,
                          node.id,
                          'result',
                          video,
                          'firstFrame',
                          plugins,
                        ),
                      );
                    } catch (error) {
                      onError(error);
                    }
                  }}
                  onConfigure={() => onConfigure(node.id)}
                  onHistory={() => mediaControls.history(node.id)}
                  onGenerate={() => mediaControls.generate(node.id)}
                  onRetry={(index, action) => mediaControls.retry(node.id, index, action)}
                  onPreview={openPreview}
                  onError={onError}
                />
              )}
              {definition?.view && (
                <CanvasNodeView
                  api={api}
                  node={node}
                  output={output}
                  definition={definition}
                  onSelect={(extend) => select(node, extend)}
                  patch={(value) =>
                    onChange({
                      ...latest.current,
                      nodes: latest.current.nodes.map((n) =>
                        n.id === node.id ? { ...n, ...value } : n,
                      ),
                    })
                  }
                />
              )}
              {!inlineMedia &&
                !definition?.view &&
                (['image', 'video', 'audio'].includes(node.kind) || node.resource) && (
                  <button
                    className="canvas-node-save"
                    aria-label={tr('{0}保存位置', [node.title])}
                    title={tr('选择保存位置，默认作品')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onConfigure(node.id)}
                  >
                    <FolderOutput size={12} />
                    {node.media?.destination?.kind === 'directory'
                      ? tr('本地目录')
                      : node.media?.destination?.kind === 'content'
                        ? tr('内容库')
                        : tr('作品')}
                  </button>
                )}
              {!inlineMedia &&
                (step?.generation?.length ? (
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
                            ? tr('完成')
                            : item.status === 'failed'
                              ? tr('失败')
                              : item.status === 'running'
                                ? tr('生成中')
                                : tr('等待')}
                        </small>
                      </div>
                    ))}
                  </div>
                ) : !definition?.view ? (
                  <ResourceThumbnail
                    api={api}
                    resource={preview}
                    showText={!!node.resource}
                    onPreview={() => openPreview(preview)}
                  />
                ) : null)}
              {node.kind === 'text' && !definition?.view && (
                <textarea
                  className="canvas-node-text"
                  aria-label={tr('编辑正文')}
                  placeholder={tr('正文')}
                  value={node.text ?? ''}
                  maxLength={32000}
                  spellCheck={false}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onFocus={() => onSelect([node.id])}
                  onChange={(e) =>
                    onChange({
                      ...latest.current,
                      nodes: latest.current.nodes.map((n) =>
                        n.id === node.id ? { ...n, text: e.target.value } : n,
                      ),
                    })
                  }
                />
              )}
              {!inlineMedia && ((node.kind !== 'text' && !definition?.view) || step?.error) && (
                <p>
                  {step?.error ||
                    output?.text ||
                    node.text ||
                    (node.resource
                      ? `${node.resource.kind} · ${'version' in node.resource ? 'v' + node.resource.version : tr('引用原件')}`
                      : tr('选择节点以配置'))}
                </p>
              )}
              {(['inputs', 'outputs'] as const).flatMap((direction) =>
                canvasPorts(node, definition)[direction].map((port, index, ports) => (
                  <button
                    key={direction + port.id}
                    className={`canvas-node-port ${direction === 'inputs' ? 'input' : 'output'}`}
                    style={{ top: `calc(${((index + 1) / (ports.length + 1)) * 100}% - 6px)` }}
                    title={`${port.label} · ${port.types.join(' / ')}`}
                    aria-label={`${node.title} ${direction === 'inputs' ? tr('输入') : tr('输出')} ${port.label}`}
                    data-port={port.id}
                    data-direction={direction}
                    onPointerEnter={(e) => {
                      if (direction !== 'outputs' || connecting || e.buttons) return;
                      clearTimeout(hoverTimer.current);
                      keepPortMenu();
                      const anchor = portAnchor(node.id, port.id, e.currentTarget);
                      hoverTimer.current = setTimeout(() => setPortMenu(anchor), 300);
                    }}
                    onPointerLeave={() => {
                      if (direction === 'outputs') leavePort();
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (e.button !== 0) return;
                      closePortMenu();
                      if (direction === 'outputs') {
                        linkDrag.current = { x: e.clientX, y: e.clientY, moved: false };
                        setConnecting({
                          nodeId: node.id,
                          portId: port.id,
                          x: node.x + (node.width ?? 240),
                          y: portY(node, 'outputs', port.id),
                        });
                      }
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      if (direction === 'inputs') finishConnection(node.id, port.id);
                      else {
                        if (linkDrag.current && !linkDrag.current.moved)
                          setPortMenu(portAnchor(node.id, port.id, e.currentTarget));
                        setConnecting(undefined);
                      }
                      linkDrag.current = undefined;
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (direction === 'inputs') finishConnection(node.id, port.id);
                      else
                        setConnecting({
                          nodeId: node.id,
                          portId: port.id,
                          x: node.x + (node.width ?? 240),
                          y: portY(node, 'outputs', port.id),
                        });
                    }}
                  >
                    <span>{port.label}</span>
                  </button>
                )),
              )}
              <button
                className="canvas-node-resize"
                aria-label={tr('调整{0}大小', [node.title])}
                title={tr('拖动调整大小；方向键微调')}
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
                <MoveDiagonal2 size={11} />
              </button>
            </article>
          );
        })}
      </div>
      {portMenu && !connecting && (
        <CanvasPortMenu
          key={portMenu.nodeId + ':' + portMenu.portId}
          canvas={canvas}
          anchor={portMenu}
          plugins={plugins}
          onChange={onChange}
          onClose={closePortMenu}
          onEnter={keepPortMenu}
          onLeave={leavePort}
          onError={onError}
        />
      )}
      {contextMenu &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={tr('节点操作')}
            className="canvas-node-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setContextMenu(undefined);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                setContextMenu(undefined);
                board.current?.focus();
              }
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                onConfigure(contextMenu.nodeId);
                setContextMenu(undefined);
              }}
            >
              <Settings2 size={14} />
              {tr(' 配置节点')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                onRemove(contextMenu.ids);
                setContextMenu(undefined);
                board.current?.focus();
              }}
            >
              <Trash2 size={14} />
              {contextMenu.ids.length > 1
                ? tr('删除选中节点（{0}）', [contextMenu.ids.length])
                : tr('删除节点')}
            </button>
          </div>,
          document.body,
        )}
      {!canvas.nodes.length && (
        <div className="canvas-empty">
          {tr('添加文本、资源或能力节点')}
          <br />
          <small>{tr('连线组织上下文与执行依赖')}</small>
        </div>
      )}
      <button className="canvas-gallery-open" onClick={() => openPreview()}>
        {tr('媒体预览')}
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
      {marquee && (
        <div
          className="canvas-marquee"
          style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
        />
      )}
      <CanvasMinimap canvas={canvas} width={size.width} height={size.height} onChange={onChange} />
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
          {tr('适应')}
        </button>
        <button aria-label={tr('缩小画布')} onClick={() => zoom(0.8, 300, 200)}>
          −
        </button>
        <button onClick={() => onChange({ ...canvas, viewport: { x: 40, y: 40, zoom: 1 } })}>
          {Math.round(canvas.viewport.zoom * 100)}%
        </button>
        <button aria-label={tr('放大画布')} onClick={() => zoom(1.25, 300, 200)}>
          ＋
        </button>
      </div>
    </div>
  );
}

const canvasNodeKinds = localized(raw_canvasNodeKinds);
