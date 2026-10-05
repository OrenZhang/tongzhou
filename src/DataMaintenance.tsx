import { useState } from 'react';
import type { TongzhouAPI } from './shared/types';

export function DataMaintenance({ api }: { api: TongzhouAPI }) {
  const [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setNotice((await fn()) || '已取消');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setPassword('');
      setConfirm(false);
    }
  };
  return (
    <section className="settings-card">
      <h3>工作数据与诊断</h3>
      <p>
        加密备份包含会话、配置、附件和文本检查点；项目文件请另外用 Git
        保存。备份不含登录凭据，恢复后连接默认停用，需要重新授权。
      </p>
      <div className="task-toolbar">
        <input
          type="password"
          autoComplete="new-password"
          aria-label="备份密码"
          placeholder="备份密码（至少 12 个字符）"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button
          className="primary"
          disabled={busy || password.length < 12}
          onClick={() => void act(() => api.backupWorkspace(password))}
        >
          创建加密备份
        </button>
      </div>
      <label className="task-confirm">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        恢复会替换当前工作数据并重启，现有数据会保留为本地回退副本。
      </label>
      <div className="task-toolbar">
        <button
          className="secondary"
          disabled={busy || !confirm || password.length < 12}
          onClick={() => void act(() => api.restoreWorkspace(password))}
        >
          从备份恢复…
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void act(() => api.exportDiagnostics())}
        >
          导出脱敏诊断
        </button>
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const r = await api.cleanUnusedData();
              return `已清理 ${r.files} 个未引用文件，释放 ${(r.bytes / 1024 / 1024).toFixed(1)} MB`;
            })
          }
        >
          清理孤立附件与检查点
        </button>
      </div>
      <div className="task-toolbar">
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const r = await api.checkRelease();
              return `当前 ${r.current} · ${r.latest ? '最新发布 ' + r.latest : '暂无正式发布版本'}`;
            })
          }
        >
          检查版本
        </button>
        <button
          className="text-button"
          onClick={() =>
            void api.openExternalLink('https://github.com/OrenZhang/tongzhou/releases')
          }
        >
          打开发布页面
        </button>
      </div>
      {busy && <p role="status">正在处理，请稍候…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
    </section>
  );
}
