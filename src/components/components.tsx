import { t as tr, getLocale } from '../shared/i18n';
import brandMark from '../shared/brand-mark.json';
import { AttachmentCards } from './files/Attachments';
import {
  X,
  LoaderCircle,
  CheckCircle2,
  Check,
  ChevronDown,
  Terminal,
  FileCode2,
} from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Markdown } from './markdown/RichMarkdown';
export { Markdown } from './markdown/RichMarkdown';
import { createPortal } from 'react-dom';
import type { Message } from '../shared/types';
import { toolLabel } from '../shared/tool-labels';
export function AuthBadge({
  connected,
  pending = false,
  error = false,
}: {
  connected?: boolean;
  pending?: boolean;
  error?: boolean;
}) {
  const label = pending
    ? tr('授权中')
    : error
      ? tr('状态待确认')
      : connected
        ? tr('已授权')
        : connected === undefined
          ? tr('检查中')
          : tr('未授权');
  return (
    <span
      role="status"
      className={
        'auth-badge ' +
        (pending ? 'pending' : error ? 'unknown' : connected ? 'connected' : 'disconnected')
      }
    >
      {connected && !pending && !error ? (
        <CheckCircle2 size={15} />
      ) : pending || connected === undefined ? (
        <Spinner />
      ) : (
        <span className="live-dot gray" />
      )}
      {label}
    </span>
  );
}
export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={'brand-mark ' + (small ? 'small' : '')} aria-hidden="true">
      <svg viewBox="0 0 256 256" fill="none">
        <rect width="256" height="256" rx="58" fill={`rgb(${brandMark.background.join(',')})`} />
        <g transform="translate(32 25) scale(4.8)">
          {brandMark.polygons.map(({ p, color }, i) => (
            <polygon
              key={i}
              points={p.map((point) => point.join(',')).join(' ')}
              fill={`rgb(${color.join(',')})`}
            />
          ))}
        </g>
      </svg>
    </span>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  compact = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  compact?: boolean;
}) {
  const modal = useRef<HTMLElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    if (!modal.current?.contains(document.activeElement))
      modal.current
        ?.querySelector<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), button:not([disabled])',
        )
        ?.focus();
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
        if (e.key !== 'Tab') return;
        // Include the model picker portal while it belongs to this dialog.
        const containers = [
          modal.current,
          document.querySelector('.model-picker-panel'),
          document.querySelector('.choice-panel'),
        ].filter(Boolean);
        const controls = containers
          .flatMap((container) => [
            ...container!.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
            ),
          ])
          .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={modal}
        className={'modal ' + (wide ? 'wide' : compact ? 'compact' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label={tr('关闭')} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id: string }>, { id })
        : children}
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function Spinner() {
  return <LoaderCircle size={16} className="spin" />;
}
export function ModelPicker({
  id,
  label,
  value,
  models,
  modelLabels = {},
  onChange,
  load,
  disabled = false,
  inherit = false,
  compact = false,
}: {
  id?: string;
  label: string;
  value: string;
  models: string[];
  modelLabels?: Record<string, string>;
  onChange: (value: string) => void;
  load?: () => Promise<string[]>;
  disabled?: boolean;
  inherit?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const attempted = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, transform: '' });
  const trigger = useRef<HTMLButtonElement>(null);
  const options = [...new Set([...models, ...discovered, ...(value ? [value] : [])])];
  const filtered = options.filter((m) =>
    (m + ' ' + (modelLabels[m] ?? '')).toLowerCase().includes(query.toLowerCase()),
  );
  const refresh = async () => {
    if (!load || loading) return;
    attempted.current = true;
    setLoading(true);
    setError('');
    try {
      setDiscovered(await load());
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : String(e)).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          '',
        ),
      );
    } finally {
      setLoading(false);
    }
  };
  const choose = (model: string) => {
    onChange(model);
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  return (
    <div
      className={`model-picker ${compact ? 'compact' : ''}`}
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        id={id}
        ref={trigger}
        type="button"
        className="model-picker-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          const rect = trigger.current!.getBoundingClientRect();
          const below = rect.bottom + 380 < window.innerHeight;
          setPosition({
            left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)),
            top: below ? rect.bottom + 8 : rect.top - 8,
            transform: below ? '' : 'translateY(-100%)',
          });
          setOpen(!open);
          setQuery('');
          if (!open && !attempted.current) void refresh();
        }}
      >
        <span>
          {modelLabels[value] || value || (inherit ? tr('继承会话模型') : tr('选择模型'))}
        </span>
        <ChevronDown size={14} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            style={position}
            className="model-picker-panel"
            role="dialog"
            aria-label={tr('{0}选择', [label])}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
                trigger.current?.focus();
              }
              if (
                !(e.target instanceof HTMLInputElement) &&
                ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)
              ) {
                e.preventDefault();
                const items = [
                  ...(panel.current?.querySelectorAll<HTMLButtonElement>(
                    '.model-picker-list button',
                  ) ?? []),
                ];
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
              }
            }}
          >
            <input
              autoFocus
              aria-label={tr('搜索模型')}
              placeholder={tr('搜索模型名称…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && filtered.length) {
                  e.preventDefault();
                  choose(filtered[0]);
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  panel.current
                    ?.querySelector<HTMLButtonElement>('.model-picker-list button')
                    ?.focus();
                }
              }}
            />
            <div className="model-picker-list">
              {inherit && !query && (
                <button type="button" onClick={() => choose('')}>
                  {tr('继承会话模型')}
                  {!value && <Check size={14} />}
                </button>
              )}
              {filtered.map((m) => (
                <button
                  type="button"
                  key={m}
                  title={m}
                  aria-pressed={m === value}
                  onClick={() => choose(m)}
                >
                  <span>{modelLabels[m] ?? m}</span>
                  {m === value && <Check size={14} />}
                </button>
              ))}
              {!filtered.length && (
                <p>
                  {loading
                    ? tr('正在获取模型…')
                    : options.length
                      ? tr('没有匹配的模型')
                      : tr('暂无模型，请获取模型列表。')}
                </p>
              )}
            </div>
            {error && (
              <p className="model-picker-error" role="status">
                {error}
                {tr('。可重试，或在模型连接中检查地址与认证。')}
              </p>
            )}
            <div className="model-picker-footer">
              <small>
                {options.length}
                {tr(' 个模型')}
              </small>
              <button
                type="button"
                className="text-button"
                disabled={!load || loading}
                onClick={() => void refresh()}
              >
                {loading ? <Spinner /> : null}
                {loading ? tr('获取中…') : tr('刷新模型列表')}
              </button>
            </div>
            {query.trim() && !options.includes(query.trim()) && (
              <button
                type="button"
                className="model-picker-custom"
                onClick={() => choose(query.trim())}
              >
                {tr('使用自定义 ID：')}
                {query.trim()}
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
export function ChatMessage({ message: m, footer }: { message: Message; footer?: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (m.role === 'system')
    return (
      <div className={'system-message ' + (m.status === 'error' ? 'error' : '')}>
        <span>•</span>
        {m.content}
      </div>
    );
  if (m.role === 'tool')
    return (
      <div className="tool-message">
        <button onClick={() => setOpen(!open)}>
          <Terminal size={14} />
          <span>{toolLabel(m.toolName)}</span>
          {m.status === 'error' ? (
            <X size={13} aria-label={tr('未完成')} />
          ) : (
            <Check size={13} aria-label={tr('已完成')} />
          )}
          <ChevronDown size={14} className={open ? 'rotate' : ''} />
        </button>
        {open && (
          <>
            <pre>{m.content}</pre>
            {m.images?.map((image, index) => (
              <img
                className="tool-screenshot"
                key={index}
                alt={tr('工具截图')}
                src={`data:${image.mimeType};base64,${image.data}`}
              />
            ))}
          </>
        )}
      </div>
    );
  const meta = (
    <div className="message-meta">
      {m.role !== 'user' && m.agent && !['CoSail', '同舟'].includes(m.agent) && (
        <strong>{m.agent}</strong>
      )}
      {m.model && <span>{m.model}</span>}
      <time>
        {new Date(m.createdAt).toLocaleTimeString(getLocale(), {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </time>
      {m.status === 'streaming' && <Spinner />}
      {m.status === 'interrupted' && <span>{tr('已中断')}</span>}
    </div>
  );
  return (
    <article
      className={'chat-message ' + m.role}
      aria-label={m.role === 'user' ? tr('你的消息') : tr('助手回复')}
    >
      <div className="message-body">
        {m.role !== 'user' && meta}
        <div className="message-content">
          <AttachmentCards items={m.attachments} />
          <Markdown
            text={m.content || (m.status === 'streaming' ? tr('正在思考…') : '')}
            streaming={m.status === 'streaming'}
          />
        </div>
        {m.toolCalls?.map((t) => (
          <div className="tool-call" key={t.id}>
            <FileCode2 size={13} />
            {t.name}
            <code>{t.arguments.slice(0, 120)}</code>
          </div>
        ))}
        {m.role === 'user' ? (
          <div className="user-message-footer">
            {meta}
            {footer}
          </div>
        ) : (
          footer
        )}
      </div>
    </article>
  );
}
