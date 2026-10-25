import type { Canvas, CanvasNode, CanvasNodeRun } from '../../shared/canvas';
import { t as tr } from '../../shared/i18n';

const operators = {
  equals: '等于',
  notEquals: '不等于',
  contains: '包含',
  gt: '大于',
  gte: '大于或等于',
  lt: '小于',
  lte: '小于或等于',
  empty: '为空',
  notEmpty: '不为空',
  truthy: '为真',
};
export function CanvasControlFields({
  canvas,
  node,
  patch,
}: {
  canvas: Canvas;
  node: CanvasNode;
  patch(p: Partial<CanvasNode>): void;
}) {
  const config = node.config ?? {};
  const update = (next: Record<string, unknown>) => patch({ config: { ...config, ...next } });
  return (
    <div className="canvas-media-fields">
      {node.pluginId === 'workflow.condition' ? (
        <>
          <label>
            {tr('输入序号')}
            <input
              aria-label={tr('输入序号')}
              type="number"
              min={1}
              max={50}
              step={1}
              value={Number(config.input ?? 1)}
              onChange={(e) => update({ input: Number(e.target.value) })}
            />
          </label>
          <label>
            {tr('字段路径')}
            <input
              aria-label={tr('字段路径')}
              value={String(config.field ?? 'text')}
              onChange={(e) => update({ field: e.target.value })}
              placeholder="value.score"
            />
          </label>
          <label>
            {tr('判断方式')}
            <select
              aria-label={tr('判断方式')}
              value={String(config.operator ?? 'contains')}
              onChange={(e) => update({ operator: e.target.value })}
            >
              {Object.entries(operators).map(([id, name]) => (
                <option key={id} value={id}>
                  {tr(name)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr('比较值')}
            <input
              aria-label={tr('比较值')}
              value={String(config.value ?? '')}
              onChange={(e) => update({ value: e.target.value })}
            />
          </label>
          <small>
            {tr(
              '用 text 判断正文，用 value.score 等路径读取 JSON 字段。满足与不满足分支需要通过分支汇合节点重新合并。',
            )}
          </small>
        </>
      ) : node.pluginId === 'workflow.foreach' ? (
        <>
          <label>
            {tr('遍历输入来源')}
            <select
              aria-label={tr('遍历输入来源')}
              value={String(config.source ?? 'auto')}
              onChange={(e) => update({ source: e.target.value })}
            >
              <option value="auto">{tr('自动识别')}</option>
              <option value="json">{tr('JSON 数组')}</option>
              <option value="resources">{tr('资源列表')}</option>
            </select>
          </label>
          <label>
            {tr('配对汇总节点')}
            <select
              aria-label={tr('配对汇总节点')}
              value={String(config.endNodeId ?? '')}
              onChange={(e) => update({ endNodeId: e.target.value })}
            >
              <option value="">{tr('请选择遍历汇总节点')}</option>
              {canvas.nodes
                .filter((n) => n.pluginId === 'workflow.collect')
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {tr('最大遍历项数')}
            <input
              aria-label={tr('最大遍历项数')}
              type="number"
              min={1}
              max={100}
              step={1}
              value={Number(config.maxItems ?? 100)}
              onChange={(e) => update({ maxItems: Number(e.target.value) })}
            />
          </label>
          <label>
            {tr('单项失败时')}
            <select
              aria-label={tr('单项失败时')}
              value={String(config.onError ?? 'stop')}
              onChange={(e) => update({ onError: e.target.value })}
            >
              <option value="stop">{tr('停止遍历')}</option>
              <option value="continue">{tr('记录错误并继续')}</option>
            </select>
          </label>
          <small>
            {tr(
              '数组输入 → 逐项遍历 → 处理节点 → 遍历汇总。所有循环体分支都应接回配对汇总；循环外节点从汇总结果继续。',
            )}
          </small>
        </>
      ) : node.pluginId === 'workflow.join' ? (
        <>
          <label>
            {tr('汇合方式')}
            <select
              aria-label={tr('汇合方式')}
              value={String(config.mode ?? 'any')}
              onChange={(e) => update({ mode: e.target.value })}
            >
              <option value="any">{tr('任一分支激活')}</option>
              <option value="all">{tr('所有分支激活')}</option>
            </select>
          </label>
          <small>
            {tr(
              '等待全部上游结束后汇合。普通节点要求全部执行依赖激活；条件与失败分支通常使用任一分支激活。',
            )}
          </small>
        </>
      ) : (
        <small>
          {tr('汇总配对循环的每项结果，保持原数组顺序。请将循环外节点连接到汇总输出。')}
        </small>
      )}
      <small>{tr('节点的失败出口可接兜底流程；取消、权限变化和执行限额不会触发失败分支。')}</small>
    </div>
  );
}

const statuses: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已停止',
  cached: '已复用',
  skipped: '已跳过',
  pending: '等待',
};
export function CanvasIterationResults({
  step,
  canvas,
  onTask,
}: {
  step: CanvasNodeRun;
  canvas: Canvas;
  onTask(id: string): void;
}) {
  return (
    <section className="canvas-iteration-results" aria-label={tr('遍历记录')}>
      <strong>{tr('遍历记录')}</strong>
      {step.iterations?.map((iteration) => (
        <details key={iteration.index}>
          <summary>
            {iteration.index + 1} · {tr(statuses[iteration.status])} ·{' '}
            {JSON.stringify(iteration.value)?.slice(0, 100)}
          </summary>
          {iteration.error && <p role="alert">{iteration.error}</p>}
          {iteration.output && <pre>{iteration.output.text.slice(0, 1000)}</pre>}
          {Object.values(iteration.external ?? {}).map((task) => (
            <small key={task.clientId}>
              {tr('远端任务：')}
              {task.promptId ?? tr('提交结果待确认')}
            </small>
          ))}
          {Object.entries(iteration.nodes).map(([id, node]) => (
            <div key={id}>
              <small>
                {canvas.nodes.find((n) => n.id === id)?.title ?? id} · {tr(statuses[node.status])}
                {node.handled ? ' · ' + tr('失败已由分支处理') : ''}
              </small>
              {node.error && <p>{node.error}</p>}
              {node.taskSessionId && (
                <button onClick={() => onTask(node.taskSessionId!)}>{tr('查看轮次任务')}</button>
              )}
              {node.iterations && (
                <CanvasIterationResults step={node} canvas={canvas} onTask={onTask} />
              )}
            </div>
          ))}
        </details>
      ))}
    </section>
  );
}
