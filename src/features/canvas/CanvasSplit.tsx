import { t as tr } from '../../shared/i18n';
import type { Canvas, CanvasNode, CanvasOutput } from '../../shared/canvas';
import { splitCategories } from '../../shared/canvas-ports';
import { materializeSplitItems } from '../../shared/canvas-editing';

export function CanvasSplitFields({
  node,
  patch,
}: {
  node: CanvasNode;
  patch(value: Partial<CanvasNode>): void;
}) {
  const rows = splitCategories(node);
  const update = (next: typeof rows) => patch({ config: { ...node.config, categories: next } });
  return (
    <div className="canvas-split-fields">
      <h3>{tr('输出定义')}</h3>
      <small>
        {tr('每类输出多个“名称 + 文字描述”。修改名称会保留原有连线；删除分类会移除该输出的连线。')}
      </small>
      {rows.map((row, index) => (
        <fieldset key={row.id}>
          <label>
            {tr('输出名称 ')}
            {index + 1}
            <input
              value={row.label}
              maxLength={60}
              onChange={(e) =>
                update(rows.map((r) => (r.id === row.id ? { ...r, label: e.target.value } : r)))
              }
            />
          </label>
          <label>
            {tr('提取要求 ')}
            {index + 1}
            <textarea
              aria-label={tr('提取要求 {0}', [index + 1])}
              rows={3}
              value={row.instruction}
              maxLength={2000}
              onChange={(e) =>
                update(
                  rows.map((r) => (r.id === row.id ? { ...r, instruction: e.target.value } : r)),
                )
              }
            />
          </label>
          <button
            disabled={rows.length === 1}
            onClick={() => update(rows.filter((r) => r.id !== row.id))}
          >
            {tr('删除输出 ')}
            {index + 1}
          </button>
        </fieldset>
      ))}
      <button
        disabled={rows.length >= 12}
        onClick={() =>
          update([
            ...rows,
            {
              id: 'output_' + crypto.randomUUID().slice(0, 8),
              label: tr('自定义内容'),
              instruction: tr('描述你希望提取的内容与格式。'),
            },
          ])
        }
      >
        {tr('添加输出类别')}
      </button>
    </div>
  );
}

export function CanvasSplitResults({
  canvas,
  node,
  output,
  onChange,
  onError,
}: {
  canvas: Canvas;
  node: CanvasNode;
  output?: CanvasOutput;
  onChange(canvas: Canvas): void;
  onError(error: unknown): void;
}) {
  if (!output?.ports) return null;
  const insert = (label: string, items: { name: string; description: string }[]) => {
    try {
      onChange(materializeSplitItems(canvas, node, label, items));
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="canvas-split-results">
      <h3>{tr('拆分结果')}</h3>
      <small>
        {tr('直接从分类端口连线，或展开为独立文本节点后编辑和连接。展开的是本次结果的副本。')}
      </small>
      {Object.entries(output.ports).map(([id, value]) => {
        const label = splitCategories(node).find((r) => r.id === id)?.label ?? id;
        const items = value.items ?? [];
        return (
          <section key={id}>
            <strong>
              {label} · {items.length}
              {tr(' 项')}
            </strong>
            <button disabled={!items.length} onClick={() => insert(label, items)}>
              {tr('展开')}
              {label}
              {tr('为文本节点')}
            </button>
            {items.map((item, index) => (
              <details key={index}>
                <summary>{item.name}</summary>
                <p>{item.description}</p>
                <button onClick={() => insert(label, [item])}>{tr('插入此项为节点')}</button>
              </details>
            ))}
            {!items.length && <small>{tr('原文未提取到此类内容')}</small>}
          </section>
        );
      })}
    </div>
  );
}
