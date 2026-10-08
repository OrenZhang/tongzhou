import { useState } from 'react';
import type { LocalGithubAccount, TongzhouAPI } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';

export function LocalGithub({ api, refresh }: { api: TongzhouAPI; refresh: () => Promise<void> }) {
  const [accounts, setAccounts] = useState<LocalGithubAccount[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="local-github">
      <div className="row">
        <span className="muted">复用本机已有登录</span>
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              if (typeof api.detectLocalGithubAccounts !== 'function')
                throw new Error('请重启同舟后使用本地账号检测');
              setAccounts(await api.detectLocalGithubAccounts());
            })
          }
        >
          {busy ? '正在处理…' : accounts ? '重新检测本地账号' : '检测本地账号'}
        </button>
      </div>
      {accounts?.map((account) => (
        <div className="row local-github-account" key={account.id}>
          <span>
            <strong>
              {account.account ?? (account.source === 'git' ? 'Git 凭据' : 'GitHub CLI')}
            </strong>
            <small className="muted">
              {account.account ? ` · ${account.source === 'git' ? 'Git 凭据' : 'GitHub CLI'}` : ''}
              {account.status === 'verified'
                ? ' · 已验证'
                : account.status === 'unverified'
                  ? ' · 登录未验证，请检查网络或重新登录'
                  : ' · 未找到可用登录'}
            </small>
          </span>
          {account.status === 'verified' && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              aria-label={`使用 ${account.account} 的${account.source === 'git' ? 'Git 凭据' : 'GitHub CLI'}并启用`}
              onClick={() =>
                void act(async () => {
                  await api.enableLocalGithubAccount(account.id);
                  await refresh();
                  setAccounts(null);
                  setNotice(`已使用 ${account.account} 启用 GitHub 插件`);
                })
              }
            >
              使用并启用
            </button>
          )}
        </div>
      ))}
      {accounts && (
        <p className="muted">
          读取 Git 和 GitHub CLI 的当前账号；使用后加密保存认证并检查插件连接。
        </p>
      )}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
    </div>
  );
}
