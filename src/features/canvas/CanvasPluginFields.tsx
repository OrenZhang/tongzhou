import { pluginLabel } from '../../shared/plugin-label';
import { t as tr } from '../../shared/i18n';
import { useEffect, useState, useRef } from 'react';
import type { CanvasNode, CanvasNodePluginDefinition } from '../../shared/canvas';
import type { Snapshot } from '../../shared/types';

function JsonField({
  value,
  onChange,
  array = false,
}: {
  value: unknown;
  onChange(v: unknown): void;
  array?: boolean;
}) {
  const encoded = JSON.stringify(value ?? (array ? [] : {}), null, 2);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(encoded),
    [error, setError] = useState('');
  useEffect(() => {
    setText(encoded);
    setError('');
    field.current?.setCustomValidity('');
  }, [encoded]);
  return (
    <>
      <textarea
        ref={field}
        aria-label={tr('JSON 参数')}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            onChange(JSON.parse(text));
            field.current?.setCustomValidity('');
            setError('');
          } catch {
            field.current?.setCustomValidity(tr('请输入有效的 JSON'));
            setError(tr('请输入有效的 JSON'));
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </>
  );
}

/** Node/plugin schemas supply extension fields; the canvas does not maintain vendor-specific forms. */
export function CanvasConfigFields({
  schema,
  value,
  onChange,
}: {
  schema: Record<string, any>;
  value: Record<string, unknown>;
  onChange(v: Record<string, unknown>): void;
}) {
  const update = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <>
      {Object.entries(schema.properties ?? {}).map(([key, field]: [string, any]) => (
        <label key={key}>
          {tr(field.title ?? key)}
          {schema.required?.includes(key) ? ' *' : ''}
          {field.enum ? (
            <select
              value={String(value[key] ?? '')}
              onChange={(e) =>
                update(
                  key,
                  field.enum.find((v: unknown) => String(v) === e.target.value),
                )
              }
            >
              <option value="">{tr('默认')}</option>
              {field.enum.map((v: unknown) => (
                <option key={String(v)} value={String(v)}>
                  {String(v)}
                </option>
              ))}
            </select>
          ) : field.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={value[key] === true}
              onChange={(e) => update(key, e.target.checked)}
            />
          ) : ['object', 'array'].includes(field.type) || !field.type ? (
            <JsonField
              value={value[key]}
              array={field.type === 'array'}
              onChange={(v) => update(key, v)}
            />
          ) : (
            <input
              type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
              min={field.minimum}
              max={field.maximum}
              step={field.type === 'integer' ? 1 : undefined}
              value={String(value[key] ?? '')}
              onChange={(e) =>
                update(
                  key,
                  e.target.value === ''
                    ? undefined
                    : field.type === 'number' || field.type === 'integer'
                      ? Number(e.target.value)
                      : e.target.value,
                )
              }
            />
          )}
          {field.description && <small>{tr(field.description)}</small>}
        </label>
      ))}
    </>
  );
}

export function CanvasPluginFields({
  data,
  definition,
  node,
  patch,
}: {
  data: Snapshot;
  definition?: CanvasNodePluginDefinition;
  node: CanvasNode;
  patch(v: Partial<CanvasNode>): void;
}) {
  const config = (node[definition?.configKey ?? 'config'] ?? {}) as Record<string, unknown>,
    update = (config: Record<string, unknown>) =>
      patch({ [definition?.configKey ?? 'config']: config });
  const plugin = data.plugins?.find((p) => p.id === config.pluginId),
    tools = plugin?.catalog ?? [],
    tool = tools.find((t) => t.name === config.tool);
  return (
    <div className="canvas-media-fields">
      <small>
        {tr('输入：')}
        {definition?.inputs.join(' / ') || tr('无')}
        {tr(' · 输出：')}
        {definition?.outputs.join(' / ') || tr('无')}
      </small>
      {definition?.adapter === 'mcp' || (node.pluginId ?? node.kind) === 'plugin' ? (
        <>
          <label>
            {tr('服务插件')}
            <select
              value={String(config.pluginId ?? '')}
              onChange={(e) => {
                const next = data.plugins?.find((p) => p.id === e.target.value);
                const tool = next?.catalog?.some((t) => t.name === config.tool)
                  ? config.tool
                  : undefined;
                update({
                  pluginId: e.target.value,
                  ...(tool ? { tool, arguments: config.arguments ?? {} } : {}),
                });
              }}
            >
              <option value="">{tr('选择已启用的插件')}</option>
              {data.plugins
                ?.filter((p) => p.enabled)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {pluginLabel(p)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {tr('工具')}
            <select
              value={String(config.tool ?? '')}
              onChange={(e) => update({ ...config, tool: e.target.value, arguments: {} })}
            >
              <option value="">{tr('选择工具')}</option>
              {tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {!tools.length && <small>{tr('在插件页检查连接后，可在这里选择工具。')}</small>}
          {tool && (
            <CanvasConfigFields
              schema={tool.inputSchema}
              value={(config.arguments ?? {}) as Record<string, unknown>}
              onChange={(args) => update({ ...config, arguments: args })}
            />
          )}
        </>
      ) : (
        <CanvasConfigFields
          schema={definition?.configSchema ?? {}}
          value={config}
          onChange={update}
        />
      )}
    </div>
  );
}
