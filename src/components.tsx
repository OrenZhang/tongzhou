import { X, LoaderCircle, Check, ChevronDown, Terminal, FileCode2 } from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
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
