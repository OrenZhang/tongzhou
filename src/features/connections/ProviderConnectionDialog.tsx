import { ConnectionDiagnostics } from '../../features/connections/ConnectionDiagnostics';
import { Check, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type {
  NativeAuthState,
  NativeEngine,
  CodexAuthState,
  ProviderInput,
  Snapshot,
} from '../../shared/types';
import { ProviderNetworkFields } from '../../features/connections/ProviderNetworkFields';
import { Field, Modal, Spinner } from '../../components/components';
import type { Dispatch, SetStateAction } from 'react';
import type { View } from '../../app/views';
import { protocolLabels, presets } from './provider-presets';
import { ProviderSecretField } from './ProviderSecretField';
import { ModelProtocolFields } from './ModelProtocolFields';
import { reasoningEfforts, reasoningLabels } from '../../shared/model-reasoning';
import {
  automaticModel,
  modelScenes,
  modelStages,
  type ModelPoolEntry,
} from '../../shared/model-protocol';

interface Props {
  data: Snapshot;
  providerEdit: ProviderInput;
  busy: boolean;
  setProviderEdit: Dispatch<SetStateAction<ProviderInput | null>>;
  perform: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  api: Window['tongzhou'];
  normalizedProvider: () => ProviderInput;
  refresh: () => Promise<void>;
  setAuthProviderId: Dispatch<SetStateAction<string | undefined>>;
  setCodex: Dispatch<SetStateAction<CodexAuthState | null>>;
  setNativeAccounts: Dispatch<SetStateAction<Partial<Record<NativeEngine, NativeAuthState>>>>;
  setAuthPanel: Dispatch<SetStateAction<'codex' | NativeEngine | null>>;
  setView: Dispatch<SetStateAction<View>>;
  fetchModels: () => Promise<void>;
  saveProvider: (test?: boolean) => Promise<void>;
}
export function ProviderConnectionDialog({
  data,
  providerEdit,
  busy,
  setProviderEdit,
  perform,
  api,
  normalizedProvider,
  refresh,
  setAuthProviderId,
  setCodex,
  setNativeAccounts,
  setAuthPanel,
  setView,
  fetchModels,
  saveProvider,
}: Props) {
  return (
    <Modal
      title={data.providers.some((p) => p.id === providerEdit.id) ? '管理模型连接' : '添加模型连接'}
      subtitle="选择服务与认证方式，保存后即可获取并选择模型。"
      onClose={() => !busy && setProviderEdit(null)}
      wide
    >
      <div className="modal-content">
        {!['codex', 'kimi', 'minimax'].includes(providerEdit.protocol) && (
          <div className="preset-row">
            {presets.map((p) => (
              <button
                key={p.name}
                onClick={() =>
                  setProviderEdit({
                    ...providerEdit,
                    ...p,
                    models: [...p.models],
                    modelLabels: undefined,
                    modelProtocols: undefined,
                    secret: '',
                    clearSecret:
                      providerEdit.baseUrl !== p.baseUrl || providerEdit.protocol !== p.protocol,
                    hasSecret:
                      providerEdit.baseUrl === p.baseUrl &&
                      providerEdit.protocol === p.protocol &&
                      providerEdit.hasSecret,
                  })
                }
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        <div className="form-grid">
          <Field label="连接名称">
            <input
              value={providerEdit.name}
              onChange={(e) => setProviderEdit({ ...providerEdit, name: e.target.value })}
            />
          </Field>
          <Field label="接口协议">
            <select
              value={providerEdit.protocol}
              disabled={['codex', 'kimi', 'minimax'].includes(providerEdit.protocol)}
              onChange={(e) =>
                setProviderEdit({
                  ...providerEdit,
                  protocol: e.target.value as ProviderInput['protocol'],
                })
              }
            >
              {Object.entries(protocolLabels)
                .filter(
                  ([k]) => !['codex', 'kimi', 'minimax'].includes(k) || k === providerEdit.protocol,
                )
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {['codex', 'kimi', 'minimax'].includes(providerEdit.protocol) ? (
          <div className="info-strip">
            <ShieldCheck size={18} />
            <span>通过官方引擎完成账号授权，完成后自动同步可选模型。</span>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const saved = await api.saveProvider(normalizedProvider());
                  await refresh();
                  setProviderEdit(null);
                  setAuthProviderId(saved.id);
                  setCodex(null);
                  setNativeAccounts({});
                  setAuthPanel(providerEdit.protocol as 'codex' | NativeEngine);
                })
              }
            >
              前往登录
            </button>
          </div>
        ) : (
          <>
            <Field
              label="API Base URL"
              hint="填写协议根地址，例如 https://api.openai.com/v1；本地 HTTP 服务也受支持。"
            >
              <input
                placeholder="https://…/v1"
                value={providerEdit.baseUrl}
                onChange={(e) => setProviderEdit({ ...providerEdit, baseUrl: e.target.value })}
              />
            </Field>
            <div className="form-grid">
              <Field label="认证方式">
                <select
                  value={providerEdit.auth}
                  onChange={(e) =>
                    setProviderEdit({
                      ...providerEdit,
                      auth: e.target.value as ProviderInput['auth'],
                    })
                  }
                >
                  <option value="api-key">API Key（按协议设置请求头）</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="none">无需认证（本地 / 自建）</option>
                </select>
              </Field>
              <ProviderSecretField
                provider={providerEdit}
                api={api}
                onChange={(secret) => setProviderEdit({ ...providerEdit, secret })}
              />
            </div>
            {providerEdit.hasSecret && (
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={providerEdit.clearSecret ?? false}
                  onChange={(e) =>
                    setProviderEdit({ ...providerEdit, clearSecret: e.target.checked })
                  }
                />
                清除已保存的密钥
              </label>
            )}
          </>
        )}
        {providerEdit.protocol === 'codex' && (
          <ProviderNetworkFields
            api={api}
            onManage={() => {
              setProviderEdit(null);
              setView('network');
            }}
            key={providerEdit.id}
            value={providerEdit.network}
            onChange={(network) => setProviderEdit({ ...providerEdit, network })}
            onTest={async () => {
              const saved = await api.saveProvider(normalizedProvider());
              await refresh();
              return api.testProviderNetwork(saved.id);
            }}
          />
        )}
        <ConnectionDiagnostics
          api={api}
          models={providerEdit.models}
          onSave={() => api.saveProvider(normalizedProvider())}
        />
        <button className="secondary" disabled={busy} onClick={fetchModels}>
          {busy ? <Spinner /> : <RefreshCw size={14} />}
          保存连接并获取模型
        </button>
        <p className="muted">
          {providerEdit.models.filter(Boolean).length} 个模型已配置，可在会话和 Agent 中搜索选择。
        </p>
        <details>
          <summary>高级：手动维护模型 ID</summary>
          <Field label="模型列表（每行一个 ID）">
            <textarea
              rows={4}
              placeholder="模型 ID，以服务商实际支持为准"
              value={providerEdit.models.join('\n')}
              onChange={(e) =>
                setProviderEdit({ ...providerEdit, models: e.target.value.split('\n') })
              }
            />
          </Field>
        </details>
        <ModelProtocolFields
          provider={providerEdit}
          onChange={(modelProtocols) => setProviderEdit({ ...providerEdit, modelProtocols })}
        />
        <ModelPoolFields
          provider={providerEdit}
          providers={data.providers}
          onChange={(modelPool) => setProviderEdit({ ...providerEdit, modelPool })}
        />
        <details className="thinking-settings">
          <summary>
            高级：模型思考 ·{' '}
            {providerEdit.thinkingEnabled === false
              ? '关闭（支持时）'
              : providerEdit.reasoningEffort
                ? `${reasoningLabels[providerEdit.reasoningEffort]} · ${providerEdit.reasoningEffort}`
                : '默认开启'}
          </summary>
          <Field
            label="模型思考"
            hint="默认开启，供使用此连接的会话共用；保存后从下一轮生效。仅控制模型生成行为，思考摘要由服务决定是否返回。"
          >
            <select
              aria-label="模型思考"
              value={providerEdit.thinkingEnabled !== false ? 'on' : 'off'}
              onChange={(e) =>
                setProviderEdit({ ...providerEdit, thinkingEnabled: e.target.value === 'on' })
              }
            >
              <option value="on">开启（默认）</option>
              <option value="off">关闭（模型支持时）</option>
            </select>
          </Field>
          {['codex', 'openai-chat', 'openai-responses', 'anthropic'].includes(
            providerEdit.protocol,
          ) && (
            <Field
              label="思考强度"
              hint="仅应用到支持档位的模型。旧版 Claude 使用下方 Token 预算；API 网关以服务实际支持为准。保存后从下一轮生效。"
            >
              <select
                aria-label="思考强度"
                disabled={providerEdit.thinkingEnabled === false}
                value={providerEdit.reasoningEffort ?? ''}
                onChange={(e) =>
                  setProviderEdit({
                    ...providerEdit,
                    reasoningEffort: e.target.value
                      ? (e.target.value as ProviderInput['reasoningEffort'])
                      : undefined,
                  })
                }
              >
                <option value="">
                  {['codex', 'anthropic'].includes(providerEdit.protocol)
                    ? '模型默认'
                    : '默认 · medium（支持时）'}
                </option>
                {reasoningEfforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {reasoningLabels[effort]} · {effort}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {providerEdit.protocol === 'anthropic' && (
            <Field
              label="旧版 Claude 思考预算 Tokens"
              hint="仅用于手动思考模型；留空沿用现有默认。至少 1024，且小于单次最大输出 Tokens。自适应模型使用上方强度。"
            >
              <input
                type="number"
                min={1024}
                max={1000000}
                step={1024}
                disabled={providerEdit.thinkingEnabled === false}
                value={providerEdit.thinkingBudgetTokens ?? ''}
                onChange={(e) =>
                  setProviderEdit({
                    ...providerEdit,
                    thinkingBudgetTokens: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
              />
            </Field>
          )}
          <p className="muted">
            始终思考的模型无法彻底关闭，会使用支持的最低强度。未识别的兼容模型和未提供开关的订阅模型沿用服务默认，并在运行记录中说明。
          </p>
        </details>
        <div className="form-grid">
          <Field
            label="单次最大输出 Tokens"
            hint="每次模型请求的输出预算；部分服务会将思考计入预算。服务或网关仍可能另设更低上限。"
          >
            <input
              type="number"
              min={256}
              max={131072}
              value={providerEdit.maxOutputTokens}
              onChange={(e) =>
                setProviderEdit({ ...providerEdit, maxOutputTokens: Number(e.target.value) })
              }
            />
          </Field>
          <Field
            label="历史上下文"
            hint="所有模型均由 Codex 自动压缩上下文并继续任务，完整记录保留在本地。"
          >
            <select
              value={providerEdit.contextChars === 0 ? 'unlimited' : 'compact'}
              onChange={(e) =>
                setProviderEdit({
                  ...providerEdit,
                  contextChars: e.target.value === 'unlimited' ? 0 : 100000,
                })
              }
            >
              <option value="unlimited">自动压缩（不设手动上限）</option>
              <option value="compact">自定义压缩阈值</option>
            </select>
          </Field>
          {providerEdit.contextChars !== 0 && (
            <Field
              label="自动整理阈值（字符）"
              hint="上下文字符预算，按约 4 字符折算 1 Token，Codex 在窗口的 80% 处自动整理；不是模型实际容量。"
            >
              <input
                type="number"
                min={4000}
                max={1000000}
                value={providerEdit.contextChars}
                onChange={(e) =>
                  setProviderEdit({
                    ...providerEdit,
                    contextChars: Number(e.target.value) || 4000,
                  })
                }
              />
            </Field>
          )}
        </div>
      </div>
      <div className="modal-footer">
        {providerEdit.id !== 'openai-codex' &&
          data.providers.some((p) => p.id === providerEdit.id) && (
            <button
              className="text-button danger"
              onClick={() =>
                perform(async () => {
                  await api.deleteProvider(providerEdit.id);
                  setProviderEdit(null);
                  await refresh();
                })
              }
            >
              <Trash2 size={15} />
              删除连接
            </button>
          )}
        <span className="spacer" />
        <button
          className="secondary"
          disabled={busy || !providerEdit.models.filter(Boolean).length}
          onClick={() => saveProvider(true)}
        >
          {providerEdit.protocol === 'codex' || ['kimi', 'minimax'].includes(providerEdit.protocol)
            ? '保存并检查账号'
            : '保存并测试调用'}
        </button>
        <button className="primary" disabled={busy} onClick={() => saveProvider()}>
          {busy ? <Spinner /> : <Check size={15} />}保存连接
        </button>
      </div>
    </Modal>
  );
}

function ModelPoolFields({
  provider,
  providers,
  onChange,
}: {
  provider: ProviderInput;
  providers: Snapshot['providers'];
  onChange(entries: ModelPoolEntry[]): void;
}) {
  const pool = provider.modelPool ?? [];
  const connections = [provider, ...providers.filter((p) => p.id !== provider.id)];
  const update = (index: number, patch: Partial<ModelPoolEntry>) =>
    onChange(pool.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  return (
    <details className="model-pool-settings" open={pool.length > 0 || undefined}>
      <summary>自动模型路由{pool.length ? ` · ${pool.length} 项` : ' · 未配置'}</summary>
      <p className="muted">
        配置后可在会话选择“自动路由”。按场景与阶段匹配，越具体的规则越优先，同优先级按列表顺序。通用默认处理未匹配请求；不可用连接会跳过。每轮开始选择一次，工具执行中保持模型与思考强度。
      </p>
      {pool.map((entry, index) => {
        const target = connections.find((p) => p.id === entry.providerId);
        return (
          <div className="model-pool-entry" key={index}>
            <Field label={`连接 · ${index + 1}`}>
              <select
                value={entry.providerId}
                onChange={(e) =>
                  update(index, {
                    providerId: e.target.value,
                    model: connections.find((p) => p.id === e.target.value)?.models[0] ?? '',
                  })
                }
              >
                {!target && <option value={entry.providerId}>连接已删除</option>}
                {connections.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.enabled === false ? '（已停用）' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="模型">
              <select
                value={entry.model}
                onChange={(e) => update(index, { model: e.target.value })}
              >
                {!target?.models.includes(entry.model) && (
                  <option value={entry.model}>{entry.model || '请先获取模型'}（不可用）</option>
                )}
                {target?.models
                  .filter((m) => m.trim() && m !== automaticModel)
                  .map((m) => (
                    <option key={m} value={m}>
                      {target.modelLabels?.[m] ?? m}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="场景">
              <select
                value={entry.scene}
                onChange={(e) =>
                  update(index, { scene: e.target.value as ModelPoolEntry['scene'] })
                }
              >
                <option value="any">通用默认</option>
                {Object.entries(modelScenes).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="阶段">
              <select
                value={entry.stage}
                onChange={(e) =>
                  update(index, { stage: e.target.value as ModelPoolEntry['stage'] })
                }
              >
                <option value="any">所有阶段</option>
                {Object.entries(modelStages).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="思考强度">
              <select
                value={entry.reasoningEffort ?? ''}
                onChange={(e) =>
                  update(index, {
                    reasoningEffort: (e.target.value ||
                      undefined) as ModelPoolEntry['reasoningEffort'],
                  })
                }
              >
                <option value="">跟随连接</option>
                {reasoningEfforts.map((v) => (
                  <option key={v} value={v}>
                    {reasoningLabels[v]} · {v}
                  </option>
                ))}
              </select>
            </Field>
            <div className="row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!entry.images}
                  onChange={(e) => update(index, { images: e.target.checked })}
                />
                支持图片
              </label>
              <button
                className="icon-button"
                aria-label={`删除路由 ${index + 1}`}
                onClick={() => onChange(pool.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        );
      })}
      {!!pool.length && !pool.some((e) => e.scene === 'any' && e.stage === 'any') && (
        <p className="danger">请保留至少一项通用默认模型。</p>
      )}
      <button
        className="secondary"
        disabled={pool.length >= 32 || !connections.some((p) => p.models.some((m) => m.trim()))}
        onClick={() => {
          const p = connections.find((p) => p.models.some((m) => m.trim()))!;
          onChange([
            ...pool,
            {
              providerId: p.id,
              model: p.models.find((m) => m.trim())!,
              scene: 'any',
              stage: 'any',
            },
          ]);
        }}
      >
        添加模型到池
      </button>
      <p className="muted">
        场景与阶段使用本地规则识别，可在会话中指定阶段。图片支持需按服务实际能力勾选；模型目录不代表账号有访问权限。思考档位由各协议适配，不支持的模型沿用服务默认。
      </p>
    </details>
  );
}
