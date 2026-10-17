import { useState } from 'react';
import type {
  Canvas,
  CanvasNode,
  CanvasNodePluginDefinition,
  CanvasEdge,
} from '../../shared/canvas';
import { canvasPorts, connectCanvasPorts } from '../../shared/canvas-ports';

export function CanvasConnections({
  canvas,
  node,
  plugins,
  onChange,
  onError,
}: {
  canvas: Canvas;
  node: CanvasNode;
  plugins: CanvasNodePluginDefinition[];
  onChange(canvas: Canvas): void;
  onError(error: unknown): void;
}) {
  const [target, setTarget] = useState(''),
    [fromPort, setFromPort] = useState(''),
    [toPort, setToPort] = useState(''),
    [kind, setKind] = useState<CanvasEdge['kind']>('dependency');
  const definition = (n: CanvasNode) => plugins.find((d) => d.id === (n.pluginId ?? n.kind));
  const ports = canvasPorts(node, definition(node)),
    destination = canvas.nodes.find((n) => n.id === target);
  const targets = destination ? canvasPorts(destination, definition(destination)).inputs : [];
  const outputId = ports.outputs.some((p) => p.id === fromPort)
    ? fromPort
    : (ports.outputs[0]?.id ?? '');
  const inputId = targets.some((p) => p.id === toPort) ? toPort : (targets[0]?.id ?? '');
  return (
    <div className="canvas-connections">
      {['image', 'video'].includes(node.kind) && (
        <small>连接参考图片会自动启用参考图模式；视频首帧、尾帧按端口匹配，需生成服务支持。</small>
      )}
      <h3>输入与输出</h3>
      <small>
        输入：{ports.inputs.map((p) => p.label).join('、') || '无'}
        <br />
        输出：{ports.outputs.map((p) => p.label).join('、') || '无'}
      </small>
      <h3>连线</h3>
      <label>
        输出端口
        <select
          aria-label="输出端口"
          value={outputId}
          onChange={(e) => setFromPort(e.target.value)}
        >
          {ports.outputs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        目标节点
        <select aria-label="目标节点" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">选择目标</option>
          {canvas.nodes
            .filter((n) => n.id !== node.id && canvasPorts(n, definition(n)).inputs.length)
            .map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
        </select>
      </label>
      <label>
        输入端口
        <select aria-label="输入端口" value={inputId} onChange={(e) => setToPort(e.target.value)}>
          <option value="">选择输入</option>
          {targets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <select
        aria-label="连线类型"
        value={kind}
        onChange={(e) => setKind(e.target.value as CanvasEdge['kind'])}
      >
        <option value="dependency">执行依赖 →</option>
        <option value="reference">资料引用 ⇢</option>
      </select>
      <button
        disabled={!target || !outputId || !inputId}
        onClick={() => {
          try {
            onChange(
              connectCanvasPorts(
                canvas,
                {
                  id: crypto.randomUUID(),
                  from: node.id,
                  to: target,
                  kind,
                  fromPort: outputId,
                  toPort: inputId,
                },
                plugins,
              ),
            );
          } catch (e) {
            onError(e);
          }
        }}
      >
        连接
      </button>
      {canvas.edges
        .filter((e) => e.from === node.id || e.to === node.id)
        .map((e) => {
          const source = canvas.nodes.find((n) => n.id === e.from)!,
            target = canvas.nodes.find((n) => n.id === e.to)!;
          const out = canvasPorts(source, definition(source)).outputs.find(
            (p) => p.id === e.fromPort,
          )?.label;
          const input = canvasPorts(target, definition(target)).inputs.find(
            (p) => p.id === e.toPort,
          )?.label;
          return (
            <div className="canvas-edge-row" key={e.id}>
              <span>
                {source.title} · {out ?? '全部'} → {target.title} · {input ?? '默认'}
                <small>{e.kind === 'dependency' ? '执行依赖' : '资料引用'}</small>
              </span>
              <button
                aria-label="删除连线"
                onClick={() =>
                  onChange({ ...canvas, edges: canvas.edges.filter((v) => v.id !== e.id) })
                }
              >
                ×
              </button>
            </div>
          );
        })}
    </div>
  );
}
