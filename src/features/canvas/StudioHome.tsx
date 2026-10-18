import { ArrowRight, GitBranch, PenTool, X } from 'lucide-react';
import type { CanvasState } from '../../shared/canvas';
import { t as tr } from '../../shared/i18n';

export function StudioHome({
  canvases,
  busy,
  error,
  onCreate,
  onOpen,
  onClose,
}: {
  canvases: CanvasState['canvases'];
  busy: boolean;
  error: string;
  onCreate(mode: 'workflow' | 'whiteboard'): void;
  onOpen(id: string): void;
  onClose?: () => void;
}) {
  return (
    <div className="studio-home">
      {onClose && (
        <button className="studio-home-close" aria-label={tr('关闭创作')} onClick={onClose}>
          <X size={16} />
        </button>
      )}
      <div className="studio-home-content">
        <header>
          <h1>{tr('开始创作')}</h1>
          <p>{tr('选择一种方式，把想法展开。')}</p>
        </header>
        <div className="studio-home-choices">
          <button
            className="studio-home-choice"
            aria-label={tr('新建画布')}
            title={tr('连接节点，编排 AI 工作流。')}
            disabled={busy}
            onClick={() => onCreate('workflow')}
          >
            <span className="studio-home-icon">
              <GitBranch size={17} />
            </span>
            <strong>{tr('工作流画布')}</strong>
          </button>
          <button
            className="studio-home-choice"
            aria-label={tr('新建白板')}
            title={tr('绘图、梳理思路，与 AI 共创。')}
            disabled={busy}
            onClick={() => onCreate('whiteboard')}
          >
            <span className="studio-home-icon">
              <PenTool size={17} />
            </span>
            <strong>{tr('白板')}</strong>
          </button>
        </div>
        {error && (
          <p className="studio-home-error" role="alert">
            {error}
          </p>
        )}
        {canvases.length > 0 && (
          <div className="studio-home-recent">
            <h2>{tr('继续创作')}</h2>
            <div className="studio-home-list">
              {canvases.map((canvas) => {
                const whiteboard = canvas.mode === 'whiteboard';
                const Icon = whiteboard ? PenTool : GitBranch;
                return (
                  <button
                    key={canvas.id}
                    data-canvas-id={canvas.id}
                    disabled={busy}
                    onClick={() => onOpen(canvas.id)}
                  >
                    <Icon size={16} />
                    <span title={canvas.title}>{canvas.title}</span>
                    <small>{whiteboard ? tr('白板') : tr('工作流画布')}</small>
                    <ArrowRight size={14} />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
