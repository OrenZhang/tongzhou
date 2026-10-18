import {
  AlignLeft,
  FileText,
  Image,
  Film,
  AudioLines,
  Bot,
  FolderOpen,
  Save,
  Puzzle,
  Code,
  Shapes,
  Box,
  StickyNote,
  Split,
  CalendarClock,
  Bell,
  Timer,
  Braces,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useId, useState } from 'react';
import type { CanvasNodePluginDefinition } from '../../shared/canvas';
import { t as tr } from '../../shared/i18n';

export const canvasNodeDragType = 'application/x-cosail-canvas-node';
const icons: Record<string, typeof AlignLeft> = {
  text: AlignLeft,
  resource: FolderOpen,
  agent: Bot,
  image: Image,
  video: Film,
  audio: AudioLines,
  save: Save,
  'visual.markdown': FileText,
  'visual.html': Code,
  'visual.svg': Shapes,
  'visual.panorama': Box,
  'visual.sticky-note': StickyNote,
  'content.split': Split,
  'workflow.schedule': CalendarClock,
  'workflow.notify': Bell,
  'workflow.delay': Timer,
  'workflow.template': Braces,
};

export function CanvasNodePalette({
  plugins,
  disabled,
  onAdd,
}: {
  plugins: CanvasNodePluginDefinition[];
  disabled?: boolean;
  onAdd(id: string): void;
}) {
  const listId = useId();
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem('cosail.canvas.palette.expanded') === 'true';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setExpanded(!expanded);
    try {
      localStorage.setItem('cosail.canvas.palette.expanded', String(!expanded));
    } catch {
      // The toggle still works when preference storage is unavailable.
    }
  };
  return (
    <aside
      className={`canvas-node-palette ${expanded ? 'expanded' : 'collapsed'}`}
      aria-label={tr('节点库')}
    >
      <header>
        <div className="canvas-node-palette-heading">
          {expanded && <strong>{tr('节点库')}</strong>}
          <button
            type="button"
            aria-label={expanded ? tr('收起节点库') : tr('展开节点库')}
            title={expanded ? tr('收起节点库') : tr('展开节点库')}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={toggle}
          >
            {expanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
        </div>
        {expanded && <span>{tr('点击或拖入画布')}</span>}
      </header>
      <div id={listId} className="canvas-node-palette-list">
        {plugins.map((plugin) => {
          const Icon = icons[plugin.id] ?? icons[plugin.kind] ?? Puzzle;
          return (
            <button
              key={plugin.id}
              type="button"
              data-node-plugin={plugin.id}
              disabled={disabled}
              draggable={!disabled}
              title={tr(plugin.name) + (plugin.description ? ' · ' + tr(plugin.description) : '')}
              aria-label={tr('添加{0}节点', [tr(plugin.name)])}
              onClick={() => onAdd(plugin.id)}
              onDragStart={(event) => {
                event.dataTransfer.setData(canvasNodeDragType, plugin.id);
                event.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <Icon size={17} aria-hidden="true" />
              {expanded && <span>{tr(plugin.name)}</span>}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
