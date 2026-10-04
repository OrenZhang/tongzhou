import { useState } from 'react';
import { Field } from './components';
import type { ProviderNetwork } from './shared/provider-network';
export function ProviderNetworkFields({
  value,
  onChange,
  onTest,
}: {
  value?: ProviderNetwork;
  onChange: (value: ProviderNetwork) => void;
  onTest: () => Promise<string>;
}) {
  const [testing, setTesting] = useState(false),
    [result, setResult] = useState('');
  const mode = value?.mode || 'inherit';
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
              ...(e.target.value === 'proxy' ? { proxyUrl: value?.proxyUrl || '' } : {}),
            });
          }}
        >
          <option value="inherit">默认网络（保持原设置）</option>
          <option value="proxy">独立代理</option>
          <option value="direct">不使用代理</option>
        </select>
      </Field>
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
              onChange({ mode: 'proxy', proxyUrl: e.target.value });
            }}
            spellCheck={false}
          />
        </Field>
      )}
      <p className="muted">
        {mode === 'inherit'
          ? '网页登录继续使用系统浏览器。'
          : '网页登录使用此账号的独立授权窗口，本机回调保持直连。系统 VPN 的全局隧道不由此设置控制。'}
      </p>
      <button
        className="secondary"
        type="button"
        disabled={testing || (mode === 'proxy' && !value?.proxyUrl?.trim())}
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
