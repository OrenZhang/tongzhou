import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Square, Terminal, X } from 'lucide-react';
import type { TongzhouAPI } from '../../shared/types';
import type { TaskState } from '../../shared/task';
import './terminal-dock.css';

const TerminalView = lazy(() => import('./TerminalView'));

export function TerminalDock({
  api,
  sessionId,
  initialId,
  disabled,
  onClose,
  fill = false,
  onDockRight,
}: {
  api: TongzhouAPI;
  sessionId: string;
  initialId: string;
  disabled: boolean;
  onClose: () => void;
  fill?: boolean;
  onDockRight?: () => void;
}) {
  const [state, setState] = useState<TaskState>();
  const [selected, setSelected] = useState(
    () => localStorage.getItem(`tongzhou-terminal-${sessionId}`) || initialId,
  );
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(
    () => Number(localStorage.getItem('tongzhou-terminal-height')) || 240,
  );
  const [limit, setLimit] = useState(400);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const report = (e: unknown) => setError(String(e).replace(/^Error: /, ''));
  useEffect(() => {
    alive.current = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await api.taskState(sessionId);
        if (alive.current) setState(next);
      } catch (e) {
        if (alive.current) report(e);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    const parent = host.current!.parentElement!;
    const observer = new ResizeObserver(() =>
      setLimit(Math.max(120, Math.min(600, parent.clientHeight * 0.45))),
    );
    observer.observe(parent);
    return () => {
      alive.current = false;
      clearInterval(timer);
      observer.disconnect();
    };
  }, [api, sessionId]);
  useEffect(() => {
    localStorage.setItem(`tongzhou-terminal-${sessionId}`, selected);
  }, [sessionId, selected]);
  const resize = (value: number) => {
    const next = Math.round(Math.max(120, Math.min(limit, value)));
    setHeight(next);
    localStorage.setItem('tongzhou-terminal-height', String(next));
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (alive.current) setState(await api.taskState(sessionId));
    } catch (e) {
      if (alive.current) report(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const current = state?.terminals.find((t) => t.id === selected);
  return (
    <section
      ref={host}
      className={`terminal-dock ${fill ? 'fill' : ''} ${collapsed ? 'collapsed' : ''}`}
      aria-label="会话终端面板"
      style={fill ? undefined : { height: collapsed ? 42 : Math.min(height, limit) }}
    >
      {!collapsed && !fill && (
        <div
          className="terminal-resizer"
          role="separator"
          aria-label="调整终端高度"
          aria-orientation="horizontal"
          aria-valuemin={120}
          aria-valuemax={Math.round(limit)}
          aria-valuenow={Math.round(Math.min(height, limit))}
          tabIndex={0}
          onKeyDown={(e) => {
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              resize(
                e.key === 'Home'
                  ? 120
                  : e.key === 'End'
                    ? limit
                    : Math.min(height, limit) + (e.key === 'ArrowUp' ? 24 : -24),
              );
            }
          }}
          onPointerDown={(e) => {
            drag.current = { y: e.clientY, height: Math.min(height, limit) };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (drag.current) resize(drag.current.height + drag.current.y - e.clientY);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        />
      )}
      <div className="terminal-dock-header">
        <div className="terminal-tabs" role="tablist" aria-label="终端标签">
          {state?.terminals.map((t, index) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={selected === t.id}
              aria-controls="terminal-content"
              title={`${t.cwd ?? ''} · ${t.status === 'running' ? '运行中' : '已结束'}`}
              onClick={() => {
                setSelected(t.id);
                setCollapsed(false);
                setError('');
              }}
            >
              <Terminal size={14} />
              <span>
                {t.title} {index + 1}
              </span>
              <i className={`terminal-status ${t.status}`} />
              <small>{t.status === 'running' ? '运行中' : '已结束'}</small>
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          aria-label="新建终端"
          title="新建终端"
          disabled={busy || disabled}
          onClick={() =>
            void act(async () => {
              const t = await api.startTerminal(sessionId);
              if (alive.current) {
                setSelected(t.id);
                setCollapsed(false);
              }
            })
          }
        >
          <Plus size={16} />
        </button>
        <div className="terminal-dock-actions">
          {onDockRight && (
            <button
              className="icon-button"
              aria-label="停靠右侧"
              title="将终端移到右侧工作区"
              onClick={onDockRight}
            >
              <Terminal size={14} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="停止终端"
            title="停止当前终端及其进程"
            disabled={busy || current?.status !== 'running'}
            onClick={() =>
              void act(async () => {
                await api.stopTerminal(sessionId, selected);
              })
            }
          >
            <Square size={13} />
          </button>
          {!fill && (
            <button
              className="icon-button"
              aria-label={collapsed ? '展开终端' : '折叠终端'}
              title={collapsed ? '展开终端' : '折叠终端'}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="关闭终端面板"
            title="关闭面板，进程继续运行"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="terminal-location" title={current?.cwd ?? state?.cwd}>
            <code>{current?.cwd ?? state?.cwd ?? '正在读取…'}</code>
            <span>关闭面板不停止进程</span>
          </div>
          {error && (
            <div className="task-error" role="alert">
              {error}
            </div>
          )}
          <div id="terminal-content" role="tabpanel" className="terminal-content">
            {selected ? (
              <Suspense fallback={<p role="status">正在打开终端…</p>}>
                <TerminalView
                  key={selected}
                  api={api}
                  sessionId={sessionId}
                  id={selected}
                  onError={report}
                  readOnly={disabled || current?.status !== 'running'}
                />
              </Suspense>
            ) : (
              <p className="task-empty">
                {disabled ? '此会话没有终端记录，恢复会话后可新建终端。' : '点击加号新建终端。'}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
