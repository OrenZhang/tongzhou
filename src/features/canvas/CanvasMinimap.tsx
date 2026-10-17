import type { Canvas } from '../../shared/canvas';
import { nodeBounds } from '../../shared/canvas-editing';

export function CanvasMinimap({
  canvas,
  width,
  height,
  onChange,
}: {
  canvas: Canvas;
  width: number;
  height: number;
  onChange(c: Canvas, record?: boolean): void;
}) {
  const v = canvas.viewport,
    bounds = nodeBounds(canvas.nodes);
  const x = Math.min(bounds.x - 40, -v.x / v.zoom),
    y = Math.min(bounds.y - 40, -v.y / v.zoom);
  const w = Math.max(bounds.x + bounds.width + 40, (width - v.x) / v.zoom) - x;
  const h = Math.max(bounds.y + bounds.height + 40, (height - v.y) / v.zoom) - y;
  return (
    <svg
      className="canvas-minimap"
      role="img"
      aria-label="画布小地图，点击或拖动定位"
      viewBox={`${x} ${y} ${w} ${h}`}
      preserveAspectRatio="none"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        locate(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) locate(e);
      }}
    >
      <rect x={x} y={y} width={w} height={h} className="minimap-background" />
      {canvas.nodes.map((n) => (
        <rect
          key={n.id}
          x={n.x}
          y={n.y}
          width={n.width ?? 240}
          height={n.height ?? 180}
          className={canvas.selection.includes(n.id) ? 'selected' : 'minimap-node'}
        />
      ))}
      <rect
        x={-v.x / v.zoom}
        y={-v.y / v.zoom}
        width={width / v.zoom}
        height={height / v.zoom}
        className="minimap-viewport"
      />
    </svg>
  );
  function locate(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = x + ((e.clientX - r.left) / r.width) * w,
      cy = y + ((e.clientY - r.top) / r.height) * h;
    onChange(
      { ...canvas, viewport: { ...v, x: width / 2 - cx * v.zoom, y: height / 2 - cy * v.zoom } },
      false,
    );
  }
}
