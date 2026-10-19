import { useState } from 'react';
import { t as tr } from '../../shared/i18n';
import type { Canvas, CanvasNode, CanvasRun } from '../../shared/canvas';
import type { Snapshot } from '../../shared/types';
import { CanvasConfigFields } from './CanvasPluginFields';

/** Both ComfyUI entry points use existing connections and schema fields. */
export function CanvasComfyFields({
  data,
  canvas,
  node,
  run,
  disabled,
  patch,
  onCheck,
  onExport,
  onResume,
}: {
  data: Snapshot;
  canvas: Canvas;
  node: CanvasNode;
  run?: CanvasRun;
  disabled: boolean;
  patch(value: Partial<CanvasNode>): void;
  onCheck(connectionId: string): Promise<string[]>;
  onExport(): Promise<void>;
  onResume(): Promise<void>;
}) {
  const [notice, setNotice] = useState<string[]>([]),
    [working, setWorking] = useState(false);
  const config = node.config ?? {},
    embedded = node.pluginId === 'comfyui.workflow';
  const connectionId = String(config.connectionId ?? '');
  const action = async (fn: () => Promise<void>) => {
    setWorking(true);
    setNotice([]);
    try {
      await fn();
    } catch (error) {
      setNotice([String(error)]);
    } finally {
      setWorking(false);
    }
  };
  const bindings = new Set(
    canvas.edges.filter((e) => e.to === node.id).map((e) => e.toPort?.slice(3)),
  );
  const properties = Object.fromEntries(
    Object.entries(node.definition?.configSchema.properties ?? {}).filter(
      ([name]) => !bindings.has(name),
    ),
  );
  const apiBindings = (Array.isArray(config.bindings) ? config.bindings : []) as {
    port: string;
    nodeId: string;
    field: string;
  }[];
  const updateBinding = (index: number, value: Partial<(typeof apiBindings)[number]>) =>
    patch({
      config: {
        ...config,
        bindings: apiBindings.map((binding, i) =>
          i === index ? { ...binding, ...value } : binding,
        ),
      },
    });
  const sourceId = embedded ? node.id : String(config.sourceId);
  return (
    <fieldset disabled={disabled || working} className="canvas-media-fields canvas-comfy-fields">
      <label>
        {tr('ComfyUI 服务')}
        <select
          aria-label={tr('ComfyUI 服务')}
          value={connectionId}
          disabled={disabled || working}
          onChange={(e) => patch({ config: { ...config, connectionId: e.target.value } })}
        >
          <option value="">{tr('选择已启用的 ComfyUI 服务')}</option>
          {(data.plugins ?? [])
            .filter((p) => p.enabled && p.protocol === 'comfyui')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      <small>{tr('在插件页添加 ComfyUI 连接。模型和自定义节点由服务端管理。')}</small>
      {!embedded && (
        <>
          <small>
            {String(config.classType)} · ID {String(config.nodeId)}
          </small>
          <button
            disabled={disabled || working || !connectionId}
            onClick={() => void action(async () => setNotice(await onCheck(connectionId)))}
          >
            {tr('检查并应用服务')}
          </button>
          {(Array.isArray(config.issues) ? config.issues : []).map((issue, i) => (
            <p key={i} role="alert">
              {String(issue)}
            </p>
          ))}
          <CanvasConfigFields
            schema={{ type: 'object', properties }}
            value={(config.values ?? {}) as Record<string, unknown>}
            onChange={(values) => patch({ config: { ...config, values } })}
          />
          {bindings.size > 0 && <small>{tr('已连线的参数由上游提供，本地值不参与覆盖。')}</small>}
          <button disabled={disabled || working} onClick={() => void action(onExport)}>
            {tr('导出 ComfyUI API')}
          </button>
        </>
      )}
      {embedded && (
        <>
          <label>
            {tr('API 工作流 JSON')}
            <textarea
              aria-label={tr('API 工作流 JSON')}
              rows={8}
              value={String(config.workflow ?? '')}
              placeholder={'{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"..."}}}'}
              onChange={(e) => {
                e.target.setCustomValidity('');
                patch({ config: { ...config, workflow: e.target.value } });
              }}
              onBlur={(e) => {
                try {
                  JSON.parse(e.target.value);
                  e.target.setCustomValidity('');
                } catch {
                  e.target.setCustomValidity(tr('请输入有效的 JSON'));
                }
              }}
            />
          </label>
          <strong>{tr('输入参数绑定')}</strong>
          {apiBindings.map((binding, index) => (
            <div className="canvas-comfy-binding" key={index}>
              <select
                aria-label={tr('绑定输入端口')}
                value={binding.port}
                onChange={(e) => updateBinding(index, { port: e.target.value })}
              >
                <option value="prompt">{tr('提示词')}</option>
                <option value="reference">{tr('参考图片')}</option>
              </select>
              <input
                aria-label={tr('流程内节点 ID')}
                placeholder={tr('流程内节点 ID')}
                value={binding.nodeId}
                onChange={(e) => updateBinding(index, { nodeId: e.target.value })}
              />
              <input
                aria-label={tr('流程参数名')}
                placeholder={tr('流程参数名')}
                value={binding.field}
                onChange={(e) => updateBinding(index, { field: e.target.value })}
              />
              <button
                aria-label={tr('删除绑定')}
                onClick={() =>
                  patch({
                    config: { ...config, bindings: apiBindings.filter((_, i) => i !== index) },
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            disabled={apiBindings.length >= 16}
            onClick={() =>
              patch({
                config: {
                  ...config,
                  bindings: [...apiBindings, { port: 'prompt', nodeId: '', field: 'text' }],
                },
              })
            }
          >
            {tr('添加参数绑定')}
          </button>
          <small>{tr('节点 ID 和参数名来自 API 流程；未连接上游时使用流程原有参数。')}</small>
        </>
      )}
      {run?.external?.[sourceId]?.promptId && run.status !== 'running' && (
        <button disabled={disabled || working} onClick={() => void action(onResume)}>
          {tr('继续查询 ComfyUI 任务')}
        </button>
      )}
      <details>
        <summary>{tr('执行与恢复')}</summary>
        <small>{tr('停止会停止本地跟踪，远端任务可能继续；继续查询不会再次提交生成。')}</small>
      </details>
      {notice.map((message, i) => (
        <p role="status" key={i}>
          {message}
        </p>
      ))}
    </fieldset>
  );
}
