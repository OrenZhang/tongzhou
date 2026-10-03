import { useEffect, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type { Session, Snapshot } from './shared/types';

export function SessionNavigator({
  data,
  sessionId,
  workspace,
  archived,
  query,
  onArchive,
  onQuery,
  onOpenProject,
  onNew,
  onSelect,
  onToggleArchive,
  onDelete,
}: {
  data: Snapshot;
  sessionId: string;
  workspace: boolean;
  archived: boolean;
  query: string;
  onArchive(): void;
  onQuery(value: string): void;
  onOpenProject(): void;
  onNew(projectId: string): void;
  onSelect(session: Session): void;
  onToggleArchive(session: Session): void;
  onDelete(session: Session): void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const activeProject = data.sessions.find((s) => s.id === sessionId)?.projectId;
  useEffect(() => {
    if (activeProject) setCollapsed((old) => ({ ...old, [activeProject]: false }));
  }, [sessionId, activeProject]);
  const matching = (s: Session) => {
    const project = data.projects.find((p) => p.id === s.projectId);
    return (
      s.archived === archived &&
      `${s.title} ${project?.name ?? ''} ${project?.path ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  };
  const row = (s: Session) => {
    const running = data.runs.some((r) => r.sessionId === s.id && r.status === 'running');
    return (
      <div
        key={s.id}
        className={'session-row' + (sessionId === s.id && workspace ? ' selected' : '')}
      >
        <button
          className="session-title"
          data-session-id={s.id}
          data-project-id={s.projectId ?? ''}
          title={
            s.projectId
              ? `${s.title}\n项目：${data.projects.find((p) => p.id === s.projectId)?.path ?? s.projectId}`
              : s.title
          }
          onClick={() => onSelect(s)}
        >
          <span className={'session-dot ' + (running ? 'live' : '')} />
          {s.projectId && <Folder size={12} aria-label="项目会话" />}
          <span>
            {s.parentId ? '↳ ' : ''}
            {s.title}
          </span>
        </button>
        <div className="session-actions">
          <button
            aria-label={s.archived ? '恢复会话' : '归档会话'}
            title={running ? '停止任务后可归档' : s.archived ? '恢复会话' : '归档会话'}
            disabled={running}
            onClick={() => onToggleArchive(s)}
          >
            {s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
          <button
            aria-label="删除会话"
            title="删除会话"
            className="session-delete"
            onClick={() => onDelete(s)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    );
  };
  return (
    <div className="sidebar-history">
      <div className="section-label">
        {archived ? '已归档会话' : '会话'}
        <button
          aria-label="切换归档会话"
          title={archived ? '查看活动会话' : '查看归档会话'}
          aria-pressed={archived}
          onClick={onArchive}
        >
          <Archive size={14} />
        </button>
      </div>
      <div className="search-box">
        <Search size={13} />
        <input
          aria-label="搜索会话"
          placeholder="搜索会话或项目"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="section-label">
        项目空间
        <button aria-label="打开项目" title="添加项目" onClick={onOpenProject}>
          <Plus size={15} />
        </button>
      </div>
      <div className="project-list">
        {data.projects
          .filter((p) => !p.removed || archived)
          .map((project) => {
            const sessions = data.sessions.filter((s) => s.projectId === project.id && matching(s));
            if (
              query &&
              !sessions.length &&
              !`${project.name} ${project.path}`.toLowerCase().includes(query.toLowerCase())
            )
              return null;
            const expanded = !!query || !collapsed[project.id];
            return (
              <section key={project.id} className="project-group" data-project-id={project.id}>
                <div className="project-group-heading">
                  <button
                    className={activeProject === project.id ? 'selected' : ''}
                    title={project.path}
                    aria-label={`项目 ${project.name}`}
                    aria-expanded={expanded}
                    onClick={() => setCollapsed((old) => ({ ...old, [project.id]: expanded }))}
                  >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <Folder size={14} />
                    <span>{project.name}</span>
                    <small>{sessions.length}</small>
                  </button>
                  <button
                    className="icon-button"
                    disabled={project.removed}
                    title="在此项目中新建会话"
                    aria-label={`在 ${project.name} 中新建会话`}
                    onClick={() => onNew(project.id)}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {expanded && (
                  <div className="session-list project-sessions">
                    {sessions.map(row)}
                    {!sessions.length && (
                      <p className="project-empty">
                        {archived ? '暂无归档会话' : '暂无会话，点击 + 开始'}
                      </p>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        {!data.projects.length && (
          <button className="subtle" onClick={onOpenProject}>
            <FolderOpen size={15} />
            添加第一个项目
          </button>
        )}
      </div>
      <div className="section-label history-label">普通会话</div>
      <div className="session-list ordinary-sessions">
        {data.sessions.filter((s) => !s.projectId && matching(s)).map(row)}
      </div>
      {!data.sessions.filter(matching).length && (
        <p className="sidebar-empty">
          {query ? '没有匹配的会话' : archived ? '暂无归档会话' : '想法从这里开始。'}
        </p>
      )}
    </div>
  );
}
