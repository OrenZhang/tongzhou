import { uiCanvasPorts as canvasPorts } from './port-labels';
import { t as tr } from '../../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Link, X } from 'lucide-react';
import type { Canvas, CanvasNodePluginDefinition } from '../../shared/canvas';
import { connectCanvasPorts, validateCanvasPorts } from '../../shared/canvas-ports';
import { appendConnectedCanvasNode, pluginCanvasNode } from '../../shared/canvas-editing';

export interface CanvasPortAnchor {
  nodeId: string;
  portId: string;
  x: number;
  y: number;
}
export function CanvasPortMenu({
  canvas,
  anchor,
  plugins,
  onChange,
  onClose,
  onEnter,
  onLeave,
  onError,
}: {
  canvas: Canvas;
  anchor: CanvasPortAnchor;
  plugins: CanvasNodePluginDefinition[];
  onChange(canvas: Canvas): void;
  onClose(): void;
  onEnter(): void;
  onLeave(): void;
  onError(error: unknown): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'new' | 'existing'>('new'),
    [query, setQuery] = useState('');
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    const wheel = (e: WheelEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', wheel, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', wheel, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', escape);
    };
  }, [onClose]);
  const source = canvas.nodes.find((n) => n.id === anchor.nodeId);
  if (!source) return null;
  const sourceDef = plugins.find((p) => p.id === (source.pluginId ?? source.kind));
  const output = canvasPorts(source, sourceDef).outputs.find((p) => p.id === anchor.portId);
  if (!output) return null;
  const edge = (to: string, toPort: string) => ({
    id: 'port-menu-preview',
    from: source.id,
    fromPort: output.id,
    to,
    toPort,
    kind: 'dependency' as const,
  });
  const existing = canvas.nodes
    .filter((n) => n.id !== source.id)
    .flatMap((node) => {
      const definition = plugins.find((p) => p.id === (node.pluginId ?? node.kind));
      return canvasPorts(node, definition).inputs.flatMap((port) => {
        try {
          connectCanvasPorts(canvas, edge(node.id, port.id), plugins);
          return [{ node, port }];
        } catch {
          return [];
        }
      });
    });
  const available = plugins.flatMap((definition) => {
    const node = pluginCanvasNode(definition);
    return canvasPorts(node, definition).inputs.flatMap((port) => {
      try {
        validateCanvasPorts(edge(node.id, port.id), source, node, sourceDef, definition);
        return [{ definition, port }];
      } catch {
        return [];
      }
    });
  });
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const run = (action: () => Canvas) => {
    try {
      onChange(action());
      onClose();
    } catch (e) {
      onError(e);
    }
  };
  return createPortal(
    <div
      ref={panel}
      className="canvas-port-menu"
      role="dialog"
      aria-label={tr('选择后续节点')}
      style={{
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - 308)),
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - 408)),
      }}
      onPointerEnter={onEnter}
      onPointerLeave={() => {
        if (!panel.current?.contains(document.activeElement)) onLeave();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header>
        <strong>{tr('选择后续节点')}</strong>
        <button aria-label={tr('关闭后续节点菜单')} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <small>
        {source.title} · {output.label}
      </small>
      <div className="canvas-port-menu-tabs">
        <button aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
          <Plus size={13} />
          {tr('新建节点')}
        </button>
        <button aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>
          <Link size={13} />
          {tr('已有节点')}
        </button>
      </div>
      <input
        aria-label={tr('搜索后续节点')}
        placeholder={tr('搜索节点或输入端口')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="canvas-port-menu-options">
        {mode === 'new'
          ? available
              .filter(({ definition, port }) => matches(tr(definition.name) + ' ' + port.label))
              .map(({ definition, port }) => (
                <button
                  key={definition.id + ':' + port.id}
                  onClick={() =>
                    run(() =>
                      appendConnectedCanvasNode(
                        canvas,
                        source.id,
                        output.id,
                        definition,
                        port.id,
                        plugins,
                      ),
                    )
                  }
                >
                  <strong>{tr(definition.name)}</strong>
                  <small>
                    {tr('输入：')}
                    {port.label}
                  </small>
                </button>
              ))
          : existing
              .filter(({ node, port }) => matches(node.title + ' ' + port.label))
              .map(({ node, port }) => (
                <button
                  key={node.id + ':' + port.id}
                  onClick={() =>
                    run(() =>
                      connectCanvasPorts(
                        canvas,
                        { ...edge(node.id, port.id), id: crypto.randomUUID() },
                        plugins,
                      ),
                    )
                  }
                >
                  <strong>{node.title}</strong>
                  <small>
                    {tr('输入：')}
                    {port.label}
                  </small>
                </button>
              ))}
        {!(mode === 'new'
          ? available.filter(({ definition, port }) =>
              matches(tr(definition.name) + ' ' + port.label),
            ).length
          : existing.filter(({ node, port }) => matches(node.title + ' ' + port.label)).length) && (
          <p>{tr('没有匹配的可连接节点')}</p>
        )}
      </div>
      <small>{tr('选择后自动连线，也可按住输出点拖到目标输入点。')}</small>
    </div>,
    document.body,
  );
}
