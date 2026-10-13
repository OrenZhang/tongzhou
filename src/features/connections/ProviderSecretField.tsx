import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { Field } from '../../components/components';
import type { ProviderInput, TongzhouAPI } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';

export function ProviderSecretField({
  provider,
  api,
  onChange,
}: {
  provider: ProviderInput;
  api: TongzhouAPI;
  onChange(secret: string): void;
}) {
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setVisible(false);
    setSaved('');
    setNotice('');
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [provider.id, provider.baseUrl, provider.auth, provider.clearSecret]);
  useEffect(() => {
    generation.current++;
    setSaved('');
    setNotice('');
    setBusy(false);
  }, [provider.secret]);
  useEffect(() => {
    if (notice !== '已复制') return;
    const timer = setTimeout(() => setNotice(''), 2000);
    return () => clearTimeout(timer);
  }, [notice]);
  const act = async (copy: boolean) => {
    if (!copy && visible) {
      setVisible(false);
      setSaved('');
      return;
    }
    const version = generation.current;
    setBusy(true);
    setNotice('');
    try {
      const secret = provider.secret || saved || (await api.revealProviderSecret(provider.id));
      if (version !== generation.current) return;
      if (copy) {
        await api.copyText(secret);
        if (version === generation.current) setNotice('已复制');
      } else {
        setSaved(secret);
        setVisible(true);
      }
    } catch (error) {
      if (version === generation.current) setNotice(errorMessage(error));
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  const available =
    !!provider.secret ||
    (!!provider.hasSecret && !provider.clearSecret && !provider.secretNeedsUpdate);
  return (
    <Field
      label="API Key / Token"
      hint={
        provider.secretNeedsUpdate && !provider.secret
          ? '旧版密钥已保留；已停止访问钥匙串，请重新填写并保存。'
          : provider.hasSecret
            ? '已有密钥；留空保留，填写可替换。'
            : '密钥加密保存，可在本机查看或复制。'
      }
    >
      <div className="provider-secret-control">
        <input
          type={visible ? 'text' : 'password'}
          aria-label="API Key / Token"
          autoComplete="new-password"
          disabled={provider.auth === 'none' || busy}
          value={provider.secret || (visible ? saved : '')}
          placeholder={
            provider.secretNeedsUpdate
              ? '请重新填写密钥（不访问钥匙串）'
              : provider.hasSecret && !provider.clearSecret
                ? '已保存，点击查看或复制'
                : '输入密钥'
          }
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="text-button"
          aria-label={visible ? '隐藏密钥' : '查看密钥'}
          title={visible ? '隐藏密钥' : '查看密钥'}
          disabled={busy || !available || provider.auth === 'none'}
          onClick={() => void act(false)}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        <button
          type="button"
          className="text-button"
          aria-label="复制密钥"
          title={notice || '复制密钥'}
          disabled={busy || !available || provider.auth === 'none'}
          onClick={() => void act(true)}
        >
          <Copy size={15} />
        </button>
      </div>
      {notice && <small role="status">{notice}</small>}
    </Field>
  );
}
