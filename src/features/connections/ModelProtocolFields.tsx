import { useState } from 'react';
import { Field } from '../../components/components';
import type { ProviderInput } from '../../shared/types';
import { apiProtocols, type ApiProtocol } from '../../shared/model-protocol';
import { protocolLabels } from './provider-presets';

export function ModelProtocolFields({
  provider,
  onChange,
}: {
  provider: ProviderInput;
  onChange(protocols: ProviderInput['modelProtocols']): void;
}) {
  const [model, setModel] = useState('');
  const models = provider.models.filter(Boolean);
  const selected = models.includes(model) ? model : models[0] || '';
  if (!apiProtocols.includes(provider.protocol as ApiProtocol) || !models.length) return null;
  const overrides = provider.modelProtocols ?? {};
  return (
    <details>
      <summary>
        高级：按模型设置接口协议
        {Object.keys(overrides).length ? ` · ${Object.keys(overrides).length} 个独立配置` : ''}
      </summary>
      <p className="muted">
        同一网关的不同模型可以使用不同协议。按服务支持情况配置，保存后从下一轮生效；请求失败不会自动切换协议重发。
      </p>
      <div className="form-grid">
        <Field label="选择配置模型">
          <select
            aria-label="选择配置模型"
            value={selected}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="此模型接口协议">
          <select
            aria-label="此模型接口协议"
            value={overrides[selected] ?? ''}
            onChange={(e) => {
              const next = { ...overrides };
              if (e.target.value) next[selected] = e.target.value as ApiProtocol;
              else delete next[selected];
              onChange(Object.keys(next).length ? next : undefined);
            }}
          >
            <option value="">继承连接 · {protocolLabels[provider.protocol]}</option>
            {apiProtocols.map((protocol) => (
              <option key={protocol} value={protocol}>
                {protocolLabels[protocol]}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </details>
  );
}
