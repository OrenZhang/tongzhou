import { WorkspaceFrame } from './WorkspaceFrame';
import { Files, GitBranch, PanelBottom, PanelRight, Terminal } from 'lucide-react';
import type { Project, Session, TongzhouAPI } from '../../shared/types';
import type { WorkspaceLayout } from './workspace-state';
import { ProjectContext } from './ProjectContext';
import { TaskPanel } from './TaskPanel';
import { TerminalDock } from './TerminalDock';

export function WorkspacePanel({
  api,
  session,
  project,
  running,
  layout,
  update,
  onTerminal,
  onReference,
  onNotice,
  fileRequest,
}: {
  api: TongzhouAPI;
  session: Session;
  project?: Project;
  running: boolean;
  layout: WorkspaceLayout;
  update(patch: Partial<WorkspaceLayout>): void;
  onTerminal(): void;
  onReference(text: string): void;
  onNotice(text: string): void;
  fileRequest?: { path: string; line: number; key: number };
}) {
  return (
    <WorkspaceFrame
      width={layout.width}
      expanded={layout.expanded}
      onResize={(width) => update({ width, expanded: false })}
      onExpand={() => update({ expanded: !layout.expanded })}
      onClose={() => update({ open: false })}
      header={
        <div role="tablist" aria-label="工作区工具">
          {(
            [
              ['files', '文件', Files],
              ['review', '审阅', GitBranch],
              ['terminal', '终端', Terminal],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={layout.tab === id}
              disabled={id === 'terminal' && !!session.knowledgeJob}
              onClick={() => (id === 'terminal' ? onTerminal() : update({ tab: id }))}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
      }
    >
      {layout.tab === 'files' &&
        (project ? (
          <ProjectContext
            key={project.id}
            fileRequest={fileRequest}
            api={api}
            project={project}
            sessionId={session.id}
            running={running}
            embedded
            onClose={() => update({ open: false })}
            onReference={onReference}
            onNotice={onNotice}
          />
        ) : (
          <div className="workspace-empty">
            <Files size={28} />
            <strong>此会话未关联项目</strong>
            <p>可在终端查看会话工作目录。打开项目后，可在这里浏览文件和预览源码。</p>
          </div>
        ))}
      {layout.tab === 'review' && (
        <>
          <div className="review-scope" role="group" aria-label="审阅范围">
            <button
              aria-pressed={layout.scope === 'task'}
              onClick={() => update({ scope: 'task' })}
            >
              本次任务改动
            </button>
            <button
              aria-pressed={layout.scope === 'directory'}
              disabled={!project}
              onClick={() => update({ scope: 'directory' })}
            >
              工作目录全部改动
            </button>
          </div>
          {layout.scope === 'directory' && project ? (
            <ProjectContext
              key={`changes-${project.id}`}
              embedded
              activeTab="changes"
              api={api}
              project={project}
              sessionId={session.id}
              running={running}
              onClose={() => update({ open: false })}
              onReference={onReference}
              onNotice={onNotice}
            />
          ) : (
            <div className="workspace-review">
              <TaskPanel
                key={`${session.id}:${layout.runId}:${layout.reviewTab}`}
                api={api}
                sessionId={session.id}
                projectId={project?.id}
                initialRunId={layout.runId}
                initialTab={layout.reviewTab}
                onSelectSession={() => update({ open: false })}
              />
            </div>
          )}
        </>
      )}
      {layout.tab === 'terminal' && (
        <>
          <div className="workspace-terminal-position">
            <span>终端停靠位置</span>
            <button
              aria-label="停靠右侧"
              aria-pressed={layout.dock === 'right'}
              onClick={() => update({ dock: 'right', terminalOpen: true })}
            >
              <PanelRight size={14} />
              右侧
            </button>
            <button
              aria-label="停靠底部"
              aria-pressed={layout.dock === 'bottom'}
              onClick={() => update({ dock: 'bottom', terminalOpen: true, open: false })}
            >
              <PanelBottom size={14} />
              底部
            </button>
          </div>
          {layout.dock === 'right' && layout.terminalOpen ? (
            <TerminalDock
              key={session.id}
              api={api}
              sessionId={session.id}
              initialId={layout.terminalId}
              fill
              disabled={!!session.archived || !!session.knowledgeJob}
              onClose={() => update({ open: false })}
            />
          ) : (
            <div className="workspace-empty">
              <Terminal size={28} />
              <p>终端已停靠在会话底部。</p>
              <button
                className="secondary"
                onClick={() => update({ dock: 'right', terminalOpen: true })}
              >
                移到右侧
              </button>
            </div>
          )}
        </>
      )}
    </WorkspaceFrame>
  );
}
