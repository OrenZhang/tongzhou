import { useState } from 'react';
import './model-capabilities.css';
import { t as tr } from '../../shared/i18n';
import {
  modelCapabilities,
  mediaModelCatalog,
  discoverMediaCapabilities,
  modelCapabilityProfile,
  type ModelCapabilities,
  type ModelCapability,
  type MediaKind,
} from '../../shared/model-capabilities';
import { canvasMediaTools } from '../../shared/canvas';
import { mediaFieldNames } from '../../shared/canvas-media-settings';
import type { PluginConfig, ProviderInput } from '../../shared/types';

export function ModelCapabilityFields({
  provider,
  plugins,
  onChange,
}: {
  provider: ProviderInput;
  plugins: PluginConfig[];
  onChange(value: ProviderInput['modelCapabilities']): void;
}) {
  const [model, setModel] = useState('');
  const models = [...new Set(provider.models.map((m) => m.trim()).filter(Boolean))];
  const selected = models.includes(model) ? model : models[0];
  if (!selected) return null;
  const config = modelCapabilityProfile(provider, selected);
  const discovered = discoverMediaCapabilities(selected, plugins);
  const value: ModelCapabilities = config ?? { capabilities: ['text'] };
  const update = (next: ModelCapabilities) =>
    onChange({ ...provider.modelCapabilities, [selected]: next });
  const toggle = (capability: ModelCapability, enabled: boolean) => {
    const caps = new Set(value.capabilities);
    if (enabled) {
      caps.add(capability);
      if (capability === 'imageEdit') caps.add('image');
      if (capability === 'imageToVideo' || capability === 'videoFrames') caps.add('video');
    } else {
      caps.delete(capability);
      if (capability === 'image') caps.delete('imageEdit');
      if (capability === 'video') {
        caps.delete('imageToVideo');
        caps.delete('videoFrames');
      }
    }
    update({ ...value, capabilities: [...caps] });
  };
  return (
    <details className="model-capability-fields">
      <summary>{tr('模型能力与画布')}</summary>
      <p className="muted">
        {tr(
          '图片理解与图片生成是不同能力。未分类模型保留对话入口；生成能力需要绑定实际工具，不会自动转用聊天接口。',
        )}
      </p>
      <label>
        {tr('配置模型能力')}
        <select
          aria-label={tr('配置模型能力')}
          value={selected}
          onChange={(e) => setModel(e.target.value)}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {provider.modelLabels?.[m] ?? m}
            </option>
          ))}
        </select>
      </label>
      {discovered && (
        <button
          type="button"
          onClick={() =>
            update({
              capabilities: [
                ...new Set([...(config?.capabilities ?? []), ...discovered.capabilities]),
              ],
              bindings: { ...discovered.bindings, ...config?.bindings },
            })
          }
        >
          {tr('采用工具目录中的能力匹配')}
        </button>
      )}
      <small>
        {tr('自动匹配仅依据工具明确列出的模型 ID；同名模型对应多个工具时，需要手动选择绑定。')}
      </small>
      <div className="model-capability-grid">
        {Object.entries(modelCapabilities).map(([key, label]) => (
          <label className="checkbox-line" key={key}>
            <input
              type="checkbox"
              checked={value.capabilities.includes(key as ModelCapability)}
              onChange={(e) => toggle(key as ModelCapability, e.target.checked)}
            />
            {tr(label)}
          </label>
        ))}
      </div>
      {(['image', 'video', 'audio'] as MediaKind[])
        .filter((kind) => value.capabilities.includes(kind))
        .map((kind) => {
          const binding = value.bindings?.[kind];
          const available = plugins
            .filter((p) => p.enabled)
            .flatMap((plugin) =>
              canvasMediaTools(plugin, kind)
                .filter((tool) =>
                  mediaFieldNames.model.some((field) => tool.inputSchema.properties?.[field]),
                )
                .map((tool) => ({ plugin, tool })),
            );
          const key = binding ? JSON.stringify([binding.pluginId, binding.tool]) : '';
          const known = available.some((a) => JSON.stringify([a.plugin.id, a.tool.name]) === key);
          const preview = {
            ...provider,
            modelCapabilities: { ...provider.modelCapabilities, [selected]: value },
          };
          const issue = mediaModelCatalog([preview], plugins, kind).find(
            (c) => c.model === selected,
          )?.issue;
          return (
            <div className="model-media-binding" key={kind}>
              <label>
                {tr(modelCapabilities[kind])} · {tr('执行工具')}
                <select
                  aria-label={`${tr(modelCapabilities[kind])} · ${tr('执行工具')}`}
                  value={key}
                  onChange={(e) => {
                    const bindings = { ...value.bindings };
                    if (!e.target.value) delete bindings[kind];
                    else {
                      const [pluginId, tool] = JSON.parse(e.target.value);
                      bindings[kind] = { pluginId, tool };
                    }
                    update({ ...value, bindings });
                  }}
                >
                  <option value="">{tr('选择实际调用的生成工具')}</option>
                  {binding && !known && <option value={key}>{tr('已绑定工具不可用')}</option>}
                  {available.map(({ plugin, tool }) => (
                    <option
                      key={JSON.stringify([plugin.id, tool.name])}
                      value={JSON.stringify([plugin.id, tool.name])}
                    >
                      {plugin.name} · {tool.name}
                    </option>
                  ))}
                </select>
              </label>
              {binding && (
                <label>
                  {tr('工具中的模型 ID')}
                  <input
                    aria-label={`${tr(modelCapabilities[kind])} · ${tr('工具中的模型 ID')}`}
                    value={binding.model ?? ''}
                    placeholder={selected}
                    maxLength={200}
                    onChange={(e) =>
                      update({
                        ...value,
                        bindings: {
                          ...value.bindings,
                          [kind]: { ...binding, model: e.target.value.trim() || undefined },
                        },
                      })
                    }
                  />
                </label>
              )}
              <small>
                {issue ? tr(issue) : tr('画布可选；实际生成使用绑定工具的连接与认证。')}
              </small>
            </div>
          );
        })}
      <small>{tr('没有模型参数的工具和 ComfyUI 工作流，仍在画布中直接选择。')}</small>
      {config && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            const next = { ...provider.modelCapabilities };
            delete next[selected];
            onChange(next);
          }}
        >
          {tr('恢复未分类')}
        </button>
      )}
    </details>
  );
}
