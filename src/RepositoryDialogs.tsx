import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen } from 'lucide-react';
import { Modal } from './components';
import type { GitRepositoryInfo, Project, Snapshot, TongzhouAPI } from './shared/types';

export function RepositoryDialog({
  project,
  data,
  api,
  onClose,
  refresh,
}: {
  project?: Project;
  data: Snapshot;
  api: TongzhouAPI;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const accounts = (data.connectors ?? []).filter(
    (c) => c.kind !== 'browser' && c.enabled && c.hasSecret,
  );
  const [account, setAccount] = useState(project?.gitConnectorId ?? '');
  const [info, setInfo] = useState<GitRepositoryInfo | null>(null);
  const [url, setUrl] = useState(''),
    [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!!project);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!project) return;
    let current = true;
    api
      .gitRepository(project.id)
      .then((value) => {
        if (current) setInfo(value);
      })
      .catch((e) => {
        if (current) setNotice(String(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [project?.id, api]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  };
  const sync = (action: 'pull' | 'push') =>
    void act(async () => {
      await api.bindGitAccount(project!.id, account);
      const result = await api.syncRepository(project!.id, action);
      setInfo(await api.gitRepository(project!.id));
      setNotice(result);
    });
  return (
    <Modal
      title={project ? `同步代码 · ${project.name}` : '克隆远程仓库'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="modal-content connection-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            if (project) {
              await api.bindGitAccount(project.id, account);
              setNotice('已保存项目账号');
            } else {
              await api.cloneRepository(account, url, directory);
              await refresh();
              onClose();
            }
          });
        }}
      >
        {notice && (
          <p role="status" className="info-strip">
            {notice}
          </p>
        )}
        {loading && <p role="status">正在读取仓库信息…</p>}
        {info && (
          <div className="settings-card">
            <strong>{info.branch || '游离 HEAD'}</strong>
            <p className="project-path">{info.remote || '尚未配置 origin 远程地址'}</p>
            <small>{info.dirty ? '有未提交修改' : '工作目录干净'}</small>
          </div>
        )}
        <label>
          代码托管账号
          <select
            aria-label="代码托管账号"
            required
            disabled={busy}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">选择已授权账号</option>
            {accounts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.account ? ` · ${c.account}` : ''} · {new URL(c.baseUrl).host}
              </option>
            ))}
          </select>
        </label>
        {!accounts.length && (
          <div className="row">
            <p>先在连接中心添加 GitHub 或 GitLab 账号并保存授权。</p>
            <button
              type="button"
              onClick={() => {
                onClose();
                void api.openModule('providers');
              }}
            >
              连接账号
            </button>
          </div>
        )}
        {!project && (
          <>
            <label>
              HTTPS 仓库地址
              <input
                required
                type="url"
                disabled={busy}
                value={url}
                placeholder="https://github.com/owner/repository.git"
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label>
              克隆到新目录
              <input
                required
                disabled={busy}
                value={directory}
                placeholder="选择父目录后创建新的仓库文件夹"
                onChange={(e) => setDirectory(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const parent = await api.chooseCloneDirectory();
                  if (parent) {
                    const name =
                      url
                        .split('/')
                        .at(-1)
                        ?.replace(/\.git$/, '') || 'repository';
                    setDirectory(
                      parent.replace(/[\\/]$/, '') +
                        (parent.includes('\\') ? '\\' : '/') +
                        name.replace(/[^\w.-]/g, '-'),
                    );
                  }
                })
              }
            >
              <FolderOpen size={14} />
              选择父目录
            </button>
            <p>克隆完成后自动添加到项目列表，可直接创建项目会话。</p>
          </>
        )}
        {project && <p>拉取只接受快进更新；推送当前分支已提交的代码，不会强制覆盖远程。</p>}
        <div className="row">
          <button
            className="primary"
            disabled={busy || loading || !account || (!!project && !info)}
          >
            {busy ? '正在处理…' : project ? '保存项目账号' : '克隆并添加项目'}
          </button>
          {project && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy || !account || !info?.branch || !info?.remote || info?.dirty}
                onClick={() => sync('pull')}
              >
                <ArrowDownToLine size={14} />
                拉取代码
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !account || !info?.branch || !info?.remote}
                onClick={() => sync('push')}
              >
                <ArrowUpFromLine size={14} />
                推送提交
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
