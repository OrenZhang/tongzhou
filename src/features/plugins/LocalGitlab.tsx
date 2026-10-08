import { useState } from 'react';
import type { LocalGitlabAccount, PluginConfig, TongzhouAPI } from '../../shared/types';
import { errorMessage } from '../../lib/feedback';

export function LocalGitlab({
  api,
  refresh,
  instance = 'https://gitlab.com',
  instances = [],
  onConfigure,
}: {
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  instance?: string;
  instances?: string[];
  onConfigure: (plugin: PluginConfig) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(instance);
  const [accounts, setAccounts] = useState<LocalGitlabAccount[] | null>(null);
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
      <label>
        检测 GitLab 实例
        <input
          aria-label="检测 GitLab 实例"
          type="url"
          placeholder="https://gitlab.com"
          value={baseUrl}
          disabled={busy}
          list="local-gitlab-instances"
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setAccounts(null);
            setNotice('');
          }}
        />
        <datalist id="local-gitlab-instances">
          {[...new Set(['https://gitlab.com', ...instances])].map((url) => (
            <option value={url} key={url} />
          ))}
        </datalist>
      </label>
      <div className="row">
        <span className="muted">复用本机已有登录</span>
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              if (typeof api.detectLocalGitlabAccounts !== 'function')
                throw new Error('请重启同舟后使用 GitLab 本地账号检测');
              setAccounts(await api.detectLocalGitlabAccounts(baseUrl));
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
              {account.account ?? (account.source === 'git' ? 'Git 凭据' : 'GitLab CLI')}
            </strong>
            <small className="muted">
              {account.account ? ` · ${account.source === 'git' ? 'Git 凭据' : 'GitLab CLI'}` : ''}
              {account.status === 'verified'
                ? ' · 已验证'
                : account.status === 'unverified'
                  ? ' · 登录未验证，请检查实例或网络'
                  : ' · 未找到可用登录'}
            </small>
          </span>
          {account.status === 'verified' && (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              aria-label={`使用 ${account.account} 的${account.source === 'git' ? 'Git 凭据' : 'GitLab CLI'}并配置`}
              onClick={() =>
                void act(async () => {
                  const plugin = await api.useLocalGitlabAccount(account.id);
                  await refresh();
                  setAccounts(null);
                  onConfigure(plugin);
                })
              }
            >
              使用并配置
            </button>
          )}
        </div>
      ))}
      {accounts && (
        <p className="muted">账号可用于 Git 操作；仓库插件需完成对应实例的浏览器授权。</p>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
