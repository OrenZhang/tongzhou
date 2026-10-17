import type { LucideIcon } from 'lucide-react';
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
  const renderItem = (item: (typeof items)[number]) => (
    <button
      key={item.id}
      aria-label={item.label}
      aria-current={view === item.id ? 'page' : undefined}
      className={`rail-button ${view === item.id ? 'active' : ''}`}
      onClick={() => onNavigate(item.id)}
    >
      <item.icon size={19} aria-hidden="true" />
      <span className="rail-tooltip" aria-hidden="true">
        {item.label}
      </span>
    </button>
  );
  return (
    <div className="rail-group" role="group" aria-label={label}>
      {items.map(renderItem)}
    </div>
  );
}
