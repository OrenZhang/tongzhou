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
  setConnectionInitialTab: Dispatch<SetStateAction<'network' | 'accounts'>>;
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
  setConnectionInitialTab,
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
              <Field
                label="API Key / Token"
                hint={
                  providerEdit.hasSecret ? '已有密钥；留空保留，填写可替换。' : '密钥不回传到界面。'
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  disabled={providerEdit.auth === 'none'}
                  value={providerEdit.secret ?? ''}
                  placeholder={providerEdit.hasSecret ? '•••••••• 已安全保存' : '输入密钥'}
                  onChange={(e) => setProviderEdit({ ...providerEdit, secret: e.target.value })}
                />
              </Field>
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
              setConnectionInitialTab('network');
              setView('connections');
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
        <ConnectionDiagnostics api={api} onSave={() => api.saveProvider(normalizedProvider())} />
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
        <details className="thinking-settings">
          <summary>
            高级：模型思考 ·{' '}
            {providerEdit.thinkingEnabled !== false ? '默认开启' : '关闭（支持时）'}
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
              hint="兼容字符预算，按约 4 字符折算 1 Token，Codex 在窗口的 80% 处自动整理；不是模型实际容量。"
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
