import { X, LoaderCircle, Check, ChevronDown, Terminal, FileCode2 } from 'lucide-react';
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
import ReactMarkdown from 'react-markdown';
import { createPortal } from 'react-dom';
import remarkGfm from 'remark-gfm';
import type { Message } from './shared/types';
export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={'brand-mark ' + (small ? 'small' : '')} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <path d="M20 5v23H7L20 5Z" fill="currentColor" />
        <path d="M24 11v17h10L24 11Z" fill="currentColor" opacity=".55" />
        <path d="M5 31h31l-6 5H12l-7-5Z" fill="currentColor" />
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
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={'modal ' + (wide ? 'wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
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
  const filtered = options.filter((m) => m.toLowerCase().includes(query.toLowerCase()));
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
        <span>{value || (inherit ? '继承会话模型' : '选择模型')}</span>
        <ChevronDown size={14} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            style={position}
            className="model-picker-panel"
            role="dialog"
            aria-label={`${label}选择`}
          >
            <input
              autoFocus
              aria-label="搜索模型"
              placeholder="搜索模型名称…"
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
                  继承会话模型{!value && <Check size={14} />}
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
                  <span>{m}</span>
                  {m === value && <Check size={14} />}
                </button>
              ))}
              {!filtered.length && (
                <p>
                  {loading
                    ? '正在获取模型…'
                    : options.length
                      ? '没有匹配的模型'
                      : '暂无模型，请获取模型列表。'}
                </p>
              )}
            </div>
            {error && (
              <p className="model-picker-error" role="status">
                {error}。可重试，或在模型连接中检查地址与认证。
              </p>
            )}
            <div className="model-picker-footer">
              <small>{options.length} 个模型</small>
              <button
                type="button"
                className="text-button"
                disabled={!load || loading}
                onClick={() => void refresh()}
              >
                {loading ? <Spinner /> : null}
                {loading ? '获取中…' : '刷新模型列表'}
              </button>
            </div>
            {query.trim() && !options.includes(query.trim()) && (
              <button
                type="button"
                className="model-picker-custom"
                onClick={() => choose(query.trim())}
              >
                使用自定义 ID：{query.trim()}
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => <span>[图片：{alt}]</span>,
          a: ({ href, children }) => (
            <span className="link-label" title={href}>
              {children}
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
export function ChatMessage({ message: m }: { message: Message }) {
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
          <span>{m.toolName ?? '工具结果'}</span>
          <Check size={13} />
          <ChevronDown size={14} className={open ? 'rotate' : ''} />
        </button>
        {open && <pre>{m.content}</pre>}
      </div>
    );
  return (
    <article className={'chat-message ' + m.role}>
      <div className="message-avatar">{m.role === 'user' ? '你' : <Mark small />}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{m.role === 'user' ? '你' : (m.agent ?? '同舟')}</strong>
          {m.model && <span>{m.model}</span>}
          <time>
            {new Date(m.createdAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          {m.status === 'streaming' && <Spinner />}
          {m.status === 'interrupted' && <span>已中断</span>}
        </div>
        <Markdown text={m.content || (m.status === 'streaming' ? '正在思考…' : '')} />
        {m.toolCalls?.map((t) => (
          <div className="tool-call" key={t.id}>
            <FileCode2 size={13} />
            {t.name}
            <code>{t.arguments.slice(0, 120)}</code>
          </div>
        ))}
      </div>
    </article>
  );
}
