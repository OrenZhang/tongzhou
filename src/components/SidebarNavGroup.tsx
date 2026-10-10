import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, MoreHorizontal, type LucideIcon } from 'lucide-react';
import type { View } from '../app/views';

export function SidebarNavGroup({
  label,
  items,
  view,
  onNavigate,
}: {
  label: string;
  items: readonly { id: View; label: string; icon: LucideIcon }[];
  view: View;
  onNavigate(view: View): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = items.length > 3;
  useEffect(() => {
    if (items.slice(1, -1).some((item) => item.id === view)) setExpanded(true);
  }, [view]);
  const renderItem = (item: (typeof items)[number]) => (
    <button
      key={item.id}
      aria-label={item.label}
      aria-current={view === item.id ? 'page' : undefined}
      className={view === item.id ? 'active' : ''}
      onClick={() => onNavigate(item.id)}
    >
      <item.icon size={16} />
      <span className="sidebar-nav-text">{item.label}</span>
    </button>
  );
  return (
    <div className="sidebar-nav-group" role="group" aria-label={label}>
      <div className="sidebar-nav-label">
        {collapsible ? (
          <button
            className="sidebar-nav-toggle"
            data-nav-expand={!expanded ? '' : undefined}
            aria-label={`${expanded ? '收起' : '展开'}${label}`}
            title={expanded ? '只显示首尾两项' : `显示全部 ${items.length} 项`}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{label}</span>
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span>{label}</span>
        )}
      </div>
      {collapsible && !expanded ? (
        <>
          {renderItem(items[0])}
          <button
            className="sidebar-nav-more"
            aria-label={`显示其余 ${items.length - 2} 项${label}`}
            title={`展开${label}`}
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            <MoreHorizontal size={16} />
          </button>
          {renderItem(items[items.length - 1])}
        </>
      ) : (
        items.map(renderItem)
      )}
    </div>
  );
}
