import { useState } from 'react';
import { FolderOpen, GitBranch, Plus, RefreshCw } from 'lucide-react';
import { Modal } from './components';
import type { Project, Snapshot, TongzhouAPI, WorktreeInfo } from './shared/types';
export function ProjectsPanel({
  data,
  api,
  refresh,
  onSession,
}: {
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  onSession: (id: string) => void;
}) {
  const [rows, setRows] = useState<Record<string, WorktreeInfo[]>>({}),
    [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [create, setCreate] = useState<Project | null>(null),
    [branch, setBranch] = useState(''),
    [ref, setRef] = useState('HEAD'),
    [remove, setRemove] = useState<WorktreeInfo | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
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
  const load = async (id: string) => {
    try {
      const list = await api.listWorktrees(id);
      setRows((old) => ({ ...old, [id]: list }));
      setErrors((old) => ({ ...old, [id]: '' }));
    } catch (e) {
      setErrors((old) => ({ ...old, [id]: String(e) }));
    }
  };
  return (
    <main className="page projects-page">
      <div className="page-heading">
        <h1>项目与工作树</h1>
        <p>在独立分支中处理任务，每个会话明确绑定工作目录。</p>
      </div>
      <div className="collection-toolbar">
        <span>项目目录和 Git 工作副本</span>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void act(() => api.addProject())}
        >
          <Plus size={15} />
          添加项目
        </button>
      </div>
      {notice && (
        <p className="info-strip" role="status">
          {notice}
        </p>
      )}
      {data.projects
        .filter((p) => !p.sourceProjectId && !p.removed)
        .map((p) => (
          <section className="settings-card project-management" key={p.id}>
            <div className="collection-toolbar">
              <div>
                <h3>
                  <FolderOpen size={17} />
                  {p.name}
                </h3>
                <p className="project-path" title={p.path}>
                  {p.path}
                </p>
              </div>
              <div className="row">
                <button className="secondary" onClick={() => onSession(p.id)}>
                  新建会话
                </button>
                <button
                  className="icon-button"
                  title="打开文件夹"
                  aria-label={`打开 ${p.name} 文件夹`}
                  onClick={() => void act(() => api.openProjectFolder(p.id))}
                >
                  <FolderOpen size={15} />
                </button>
              </div>
            </div>
            <div className="row">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void act(() => load(p.id))}
              >
                <RefreshCw size={14} />
                查看工作树
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setCreate(p);
                  setBranch('');
                  setRef('HEAD');
                }}
              >
                <GitBranch size={14} />
                新建工作树
              </button>
            </div>
            {errors[p.id] && <p role="status">{errors[p.id]} 普通文件夹仍可用于会话。</p>}
            {rows[p.id]?.map((w) => (
              <div className="worktree-row" key={w.path}>
                <GitBranch size={16} />
                <div>
                  <strong>{w.branch || '游离 HEAD'}</strong>
                  <span className="tag">
                    {w.main ? '主工作树' : w.managed ? '同舟管理' : '外部工作树'}
                  </span>
                  <p className="project-path" title={w.path}>
                    {w.path}
                  </p>
                  <small>
                    {w.prunable
                      ? '路径不可用'
                      : w.locked
                        ? '已锁定'
                        : w.dirty
                          ? '有本地文件或修改'
                          : w.unsharedCommits
                            ? '有未推送或合并的提交'
                            : '工作目录干净'}
                  </small>
                </div>
                <div className="row">
                  {w.projectId && !w.prunable && (
                    <button disabled={busy} onClick={() => onSession(w.projectId!)}>
                      进入会话
                    </button>
                  )}
                  {w.managed && !w.main && (
                    <button
                      className="text-button danger"
                      disabled={busy || w.dirty || w.locked || w.prunable || w.unsharedCommits}
                      onClick={() => setRemove(w)}
                    >
                      移除
                    </button>
                  )}
                </div>
              </div>
            ))}
          </section>
        ))}
      {!data.projects.some((p) => !p.removed) && (
        <div className="empty-state">
          <FolderOpen size={30} />
          <h3>从一个本地项目开始</h3>
          <p>添加已有文件夹即可聊天和修改代码；Git 仓库还可创建独立工作树。</p>
        </div>
      )}
      {create && (
        <Modal title="新建 Git 工作树" onClose={() => setCreate(null)}>
          <form
            className="modal-content connection-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const p = await api.createWorktree(create.id, branch, ref);
                await load(create.id);
                setCreate(null);
                setNotice(`已创建 ${p.name}，可进入会话。`);
              });
            }}
          >
            <p>为 {create.name} 创建独立目录和新分支，当前目录的未提交修改会保留在原处。</p>
            <label>
              新分支名称
              <input
                autoFocus
                required
                placeholder="feature/my-task"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </label>
            <label>
              起点（分支、标签或提交）
              <input required value={ref} onChange={(e) => setRef(e.target.value)} />
            </label>
            <p>HEAD 表示当前提交。创建后不会复制本地未提交文件或执行项目初始化脚本。</p>
            <button className="primary" disabled={busy}>
              创建工作树
            </button>
          </form>
        </Modal>
      )}
      {remove && (
        <Modal title="移除工作树" onClose={() => setRemove(null)}>
          <div className="modal-content connection-form">
            <p>
              将移除目录 {remove.path}。会话历史会保留并归档，Git
              分支会保留。移除前还会检查运行任务和目录状态。
            </p>
            <button
              className="primary danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.removeWorktree(remove.projectId!);
                  setRows({});
                  setRemove(null);
                })
              }
            >
              确认移除工作树
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
