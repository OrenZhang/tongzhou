import { useState, useEffect } from 'react';
import type { TongzhouAPI } from '../../shared/types';
import type { NetworkProfile } from '../../shared/network-profile';
import { Field } from '../../components/components';
import type { ProviderNetwork } from '../../shared/provider-network';
export function ProviderNetworkFields({
  value,
  onChange,
  onTest,
  api,
  onManage,
}: {
  value?: ProviderNetwork;
  onChange: (value: ProviderNetwork) => void;
  onTest: () => Promise<string>;
  api: TongzhouAPI;
  onManage: () => void;
}) {
  const [testing, setTesting] = useState(false),
    [result, setResult] = useState('');
  const mode = value?.mode || 'inherit';
  const [profiles, setProfiles] = useState<NetworkProfile[]>([]);
  useEffect(() => {
    let live = true;
    api
      .networkProfiles()
      .then((v) => {
        if (live) setProfiles(v.profiles);
      })
      .catch(() => {
        if (live) setResult('读取内置网络配置失败');
      });
    return () => {
      live = false;
    };
  }, [api]);
  return (
    <div className="provider-network-fields">
      <Field
        label="此 ChatGPT 连接的网络"
        hint="只应用于当前账号的授权、模型列表和聊天请求，不修改系统代理或其他连接。"
      >
        <select
          aria-label="ChatGPT 网络方式"
          value={mode}
          disabled={testing}
          onChange={(e) => {
            setResult('');
            onChange({
              mode: e.target.value as ProviderNetwork['mode'],
              ...(value?.transport ? { transport: value.transport } : {}),
              ...(e.target.value === 'proxy' ? { proxyUrl: value?.proxyUrl || '' } : {}),
              ...(e.target.value === 'managed' ? { profileId: value?.profileId || '' } : {}),
            });
          }}
        >
          <option value="inherit">默认网络（保持原设置）</option>
          <option value="proxy">独立代理</option>
          <option value="managed">内置网络配置（同舟自动运行）</option>
          <option value="direct">不使用代理</option>
        </select>
      </Field>
      {mode === 'managed' && (
        <>
          <Field label="选择网络配置" hint="使用时自动启动内核。配置更改不会修改系统网络。">
            <select
              aria-label="ChatGPT 内置网络配置"
              value={value?.profileId || ''}
              disabled={testing}
              onChange={(e) => {
                setResult('');
                onChange({ ...value, mode: 'managed', profileId: e.target.value });
              }}
            >
              <option value="">请选择…</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.selected}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="text-button" disabled={testing} onClick={onManage}>
            管理网络配置（设置 → 连接中心 → 网络配置）
          </button>
        </>
      )}
      {mode === 'proxy' && (
        <Field
          label="HTTP / HTTPS 代理地址"
          hint="填写代理软件的 HTTP 或混合端口，例如 http://127.0.0.1:7890。此处不是模型 API 地址；暂不支持带密码的代理或 SOCKS 专用端口。"
        >
          <input
            aria-label="ChatGPT 独立代理地址"
            value={value?.proxyUrl || ''}
            placeholder="http://127.0.0.1:7890"
            disabled={testing}
            onChange={(e) => {
              setResult('');
              onChange({ ...value, mode: 'proxy', proxyUrl: e.target.value });
            }}
            spellCheck={false}
          />
        </Field>
      )}
      <Field
        label="ChatGPT 传输方式"
        hint="两种方式均使用加密连接，支持流式回复与工具调用，不改变模型能力。代理下 WebSocket 反复超时可使用 HTTPS 流式。"
      >
        <select
          aria-label="ChatGPT 传输方式"
          value={value?.transport || 'auto'}
          disabled={testing}
          onChange={(e) => {
            setResult('');
            onChange({ ...value, mode, transport: e.target.value as 'http' | 'auto' });
          }}
        >
          <option value="auto">自动（优先 WebSocket，默认）</option>
          <option value="http">HTTPS 流式（代理兼容方式）</option>
        </select>
      </Field>
      <p className="muted">
        {mode === 'inherit'
          ? '网页登录继续使用系统浏览器。'
          : '网页登录使用此账号的独立授权窗口，本机回调保持直连。系统 VPN 的全局隧道不由此设置控制。'}
      </p>
      <button
        className="secondary"
        type="button"
        disabled={
          testing ||
          (mode === 'proxy' && !value?.proxyUrl?.trim()) ||
          (mode === 'managed' && !value?.profileId)
        }
        onClick={async () => {
          setTesting(true);
          setResult('');
          try {
            setResult(await onTest());
          } catch (e) {
            setResult(
              String(e)
                .replace(/^Error: /, '')
                .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''),
            );
          } finally {
            setTesting(false);
          }
        }}
      >
        {testing ? '正在检查网络…' : '保存并测试账号网络'}
      </button>
      {result && (
        <p className="muted" role="status">
          {result}
        </p>
      )}
    </div>
  );
}
