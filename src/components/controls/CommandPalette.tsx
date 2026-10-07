import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Search, type LucideIcon } from 'lucide-react';
import { Modal } from '../components';

export interface QuickAction {
  id: string;
  title: string;
  detail: string;
  icon: LucideIcon;
  run(): void;
}

export function CommandPalette({ actions, onClose }: { actions: QuickAction[]; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const matches = actions
    .filter((a) => `${a.title} ${a.detail}`.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 30);
  const choose = (action: QuickAction) => {
    onClose();
    action.run();
  };
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);
  return (
    <Modal title="搜索与快捷操作" onClose={onClose}>
      <div className="command-palette">
        <div className="command-search">
          <Search size={18} />
          <input
            autoFocus
            role="combobox"
            aria-label="搜索操作或会话"
            aria-expanded="true"
            aria-controls="quick-action-list"
            aria-activedescendant={matches[active] ? `quick-action-${active}` : undefined}
            placeholder="搜索会话、项目或功能…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((value) =>
                  Math.max(
                    0,
                    Math.min(matches.length - 1, value + (e.key === 'ArrowDown' ? 1 : -1)),
                  ),
                );
              }
              if (e.key === 'Enter' && matches[active]) {
                e.preventDefault();
                choose(matches[active]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div
          className="command-results"
          role="listbox"
          id="quick-action-list"
          aria-label="快捷操作结果"
          ref={list}
        >
          {matches.map((action, index) => (
            <button
              key={action.id}
              id={`quick-action-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={active === index}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(action)}
            >
              <action.icon size={17} />
              <span>
                <strong>{action.title}</strong>
                <small>{action.detail}</small>
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
          {!matches.length && (
            <div className="empty-state compact">
              <Search size={24} />
              <p>没有找到匹配项，试试其他关键词。</p>
            </div>
          )}
        </div>
        <div className="command-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 打开
          </span>
          <span>只搜索本地会话与功能</span>
        </div>
      </div>
    </Modal>
  );
}
