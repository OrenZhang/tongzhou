import {
  Check,
  PencilLine,
  MoreHorizontal,
  Folder,
  ArrowUp,
  Square,
  LoaderCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ArtifactCards } from '../artifacts/Artifacts';
import type { KnowledgeDocument, KnowledgeFolder, KnowledgeRead } from '../../shared/knowledge';
import type { Message, Snapshot, TongzhouAPI } from '../../shared/types';
import { ChoicePicker } from '../../components/controls/ChoicePicker';
import { Markdown, Modal } from '../../components/components';
import { knowledgeFolderPath } from '../../shared/knowledge';

type Draft = { title: string; content: string; version: number };
export function ContentDocument({
  api,
  data,
  documentId,
  folders,
  showChat,
  onChange,
  onOpen,
  onDelete,
  onArtifact,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  documentId: string;
  folders: KnowledgeFolder[];
  showChat: boolean;
  onChange(): Promise<void>;
  onOpen(id: string): void;
  onDelete(): void;
  onArtifact?(id: string): void;
}) {
  const [read, setRead] = useState<KnowledgeRead>();
  const [draft, setDraft] = useState<Draft>();
  const draftRef = useRef<Draft | undefined>(undefined);
  const base = useRef<KnowledgeDocument | undefined>(undefined);
  const pending = useRef<Promise<void> | null>(null);
  const conflict = useRef(false);
  const key = 'tongzhou-content-draft:' + documentId;
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在读取…');
  const [preview, setPreview] = useState(true);
  const menu = useRef<HTMLDetailsElement>(null);
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [providerId, setProviderId] = useState(
    data.providers.find((p) => p.enabled !== false)?.id ?? '',
  );
  const [model, setModel] = useState(
    data.providers.find((p) => p.enabled !== false)?.models[0] ?? '',
  );
  const [selection, setSelection] = useState<{ start: number; end: number; text: string }>();
  const dirty = () =>
    !!base.current &&
    !!draftRef.current &&
    (base.current.title !== draftRef.current.title ||
      base.current.content !== draftRef.current.content);
  const setValue = (value: Draft, persist = true) => {
    draftRef.current = value;
    setDraft(value);
    if (persist) setStatus('未保存 · 即将自动保存');
    if (persist)
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        setError('本地草稿缓存已满，请保存正文后再离开');
      }
  };
  const load = async (reset = false) => {
    const value = await api.knowledgeRead(documentId);
    setRead(value);
    if (!base.current || reset) {
      base.current = value.document;
      conflict.current = false;
      let saved: Draft | undefined;
      if (!reset)
        try {
          saved = JSON.parse(localStorage.getItem(key) || 'null');
        } catch {
          /* no draft */
        }
      if (saved && typeof saved.content === 'string' && typeof saved.title === 'string') {
        setValue(saved, false);
        if (saved.version !== value.document.version) {
          conflict.current = true;
          setError('正文已有新版本，本地草稿已保留。可另存副本，或重新载入最新正文。');
        }
        setStatus('已恢复本地草稿');
      } else {
        setValue(
          {
            title: value.document.title,
            content: value.document.content,
            version: value.document.version,
          },
          false,
        );
        setStatus('已保存');
      }
      if (reset) {
        localStorage.removeItem(key);
        setError('');
      }
    } else if (!pending.current && value.document.version !== base.current.version) {
      if (dirty()) {
        conflict.current = true;
        setError('AI 或其他编辑已更新正文，本地草稿仍保留。请另存副本或重新载入。');
      } else {
        base.current = value.document;
        setValue(
          {
            title: value.document.title,
            content: value.document.content,
            version: value.document.version,
          },
          false,
        );
        setSelection(undefined);
        setStatus('已更新到最新版本');
      }
    }
  };
  const save = async (): Promise<void> => {
    if (pending.current) {
      await pending.current;
      if (dirty()) return save();
      return;
    }
    if (!dirty()) return;
    if (conflict.current) throw new Error('存在版本冲突，请先处理本地草稿');
    const original = base.current!,
      value = draftRef.current!;
    if (!value.title.trim()) throw new Error('请填写文档标题');
    if (original.origin === 'import') return;
    setStatus('正在保存…');
    pending.current = (async () => {
      try {
        const saved = await api.contentWrite({
          id: original.id,
          version: original.version,
          libraryId: original.libraryId ?? 'default',
          title: value.title,
          content: value.content,
        });
        base.current = saved;
        const latest = draftRef.current!;
        setValue({ ...latest, version: saved.version }, false);
        if (latest.title === value.title && latest.content === value.content)
          localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ ...latest, version: saved.version }));
        setStatus('已保存');
        setError('');
        await onChange();
      } catch (e) {
        setStatus('保存未完成');
        setError(String(e));
        throw e;
      } finally {
        pending.current = null;
      }
    })();
    await pending.current;
  };
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    void load().catch((e) => setError(String(e)));
    void api.contentConversation(documentId).then((id) => {
      if (live) setSessionId(id ?? '');
    });
    const off = api.onEvent((e) => {
      if (e.type === 'changed') {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (live) void load().catch((e) => setError(String(e)));
        }, 300);
      }
    });
    return () => {
      live = false;
      clearTimeout(timer);
      off();
    };
  }, [documentId]);
  useEffect(() => {
    if (!draft || !dirty() || conflict.current || base.current?.origin === 'import') return;
    const timer = setTimeout(() => void save().catch((e) => setError(String(e))), 900);
    return () => clearTimeout(timer);
  }, [draft?.title, draft?.content, draft?.version]);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    void api.messages(sessionId, { limit: 200 }).then((value) => {
      if (live) setMessages(value);
    });
    const off = api.onEvent((e) => {
      if (e.type === 'message' && e.message.sessionId === sessionId)
        setMessages((old) =>
          old.some((m) => m.id === e.message.id)
            ? old.map((m) => (m.id === e.message.id ? e.message : m))
            : [...old, e.message],
        );
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId]);
  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof KeyboardEvent || !menu.current?.contains(event.target as Node))
        menu.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  const active = data.runs.some((r) => r.sessionId === sessionId && r.status === 'running');
  const lastRun = data.runs
    .filter((r) => r.sessionId === sessionId)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const perform = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  const sendMessage = () => {
    if (!prompt.trim() || !providerId || !model || active || sendingRef.current || !read) return;
    sendingRef.current = true;
    setSending(true);
    void perform(async () => {
      try {
        await save();
        const result = await api.contentRun({
          documentId,
          version: base.current!.version,
          providerId,
          model,
          prompt,
          selection,
        });
        setSessionId(result.sessionId);
        setPrompt('');
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    });
  };
  const copy = async () => {
    const d = await api.contentWrite({
      libraryId: base.current?.libraryId ?? 'default',
      folderId: base.current?.folderId,
      title: (draftRef.current?.title || '文档') + ' · 副本',
      content: draftRef.current?.content ?? '',
      sourceIds: [documentId],
    });
    await onChange();
    onOpen(d.id);
  };
  return (
    <>
      <main className="content-editor">
        {error && (
          <p className="danger" role="alert">
            {error}
          </p>
        )}
        {draft && read ? (
          <>
            <header className="content-document-header">
              <div className="content-document-heading">
                <input
                  className="content-title"
                  aria-label="文档标题"
                  maxLength={180}
                  readOnly={preview || read.document.origin === 'import'}
                  value={draft.title}
                  onChange={(e) => setValue({ ...draft, title: e.target.value })}
                />
                <div className="content-editor-actions">
                  {read.document.origin !== 'import' && (
                    <button
                      className="icon-button"
                      aria-label={preview ? '编辑正文' : '完成编辑'}
                      title={preview ? '编辑正文' : '完成编辑（自动保存）'}
                      onClick={() => {
                        if (preview) setPreview(false);
                        else
                          void perform(async () => {
                            await save();
                            setPreview(true);
                            setSelection(undefined);
                          });
                      }}
                    >
                      {preview ? <PencilLine size={16} /> : <Check size={16} />}
                    </button>
                  )}
                  <details ref={menu} className="content-document-menu">
                    <summary aria-label="更多文档操作" title="更多文档操作">
                      <MoreHorizontal size={18} />
                    </summary>
                    <div
                      className="content-document-menu-panel"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button'))
                          menu.current?.removeAttribute('open');
                      }}
                    >
                      <button className="text-button" onClick={() => void perform(copy)}>
                        另存副本
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          void perform(async () => {
                            await save();
                            await load();
                            setHistory(!history);
                          })
                        }
                      >
                        版本记录
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          void perform(async () => {
                            await save();
                            await api.contentExport(documentId);
                          })
                        }
                      >
                        导出
                      </button>
                      <button className="text-button danger" onClick={() => setDeleting(true)}>
                        删除
                      </button>
                    </div>
                  </details>
                </div>
              </div>
              <div className="content-document-info">
                <span
                  className="content-document-path"
                  title={knowledgeFolderPath(folders, read.document.folderId) || '未分类'}
                >
                  <Folder size={13} />
                  {knowledgeFolderPath(folders, read.document.folderId) || '未分类'}
                </span>
                <small role="status">
                  {status} · v{base.current?.version}
                </small>
                <small>{draft.content.length.toLocaleString()} 字符</small>
                <small title={new Date(read.document.updatedAt).toLocaleString()}>
                  更新于 {new Date(read.document.updatedAt).toLocaleDateString()}
                </small>
              </div>
            </header>
            {conflict.current && (
              <button className="secondary" onClick={() => void perform(() => load(true))}>
                丢弃本地草稿并载入最新正文
              </button>
            )}
            {read.document.origin === 'import' && (
              <p className="muted">
                导入原件保留不变。可另存副本后编辑，或让 AI 生成关联的新文档。
              </p>
            )}
            {history && (
              <div className="content-versions">
                {read.revisions.length ? (
                  read.revisions.map((r) => (
                    <div key={r.id}>
                      <span>
                        v{r.version} · {new Date(r.updatedAt).toLocaleString()}
                      </span>
                      <button
                        onClick={() =>
                          void perform(async () => {
                            await save();
                            await api.knowledgeRestore(
                              documentId,
                              r.version,
                              base.current!.version,
                            );
                            await load(true);
                            await onChange();
                          })
                        }
                      >
                        恢复此版本
                      </button>
                    </div>
                  ))
                ) : (
                  <p>尚无历史版本</p>
                )}
              </div>
            )}
            {preview ? (
              <article className="content-body-preview" aria-label="文档内容" tabIndex={0}>
                {draft.content ? (
                  <Markdown
                    text={draft.content}
                    onKnowledgeLink={(target) => {
                      const link = read.links.find((item) => item.target === target);
                      if (link?.id) onOpen(link.id);
                      else
                        setError(
                          link?.ambiguous
                            ? '存在同名文档，请使用文档 ID 关联。'
                            : '关联文档不存在或已删除。',
                        );
                    }}
                  />
                ) : (
                  <p className="muted">暂无内容</p>
                )}
              </article>
            ) : (
              <textarea
                className="content-body"
                aria-label="文档正文"
                placeholder="在这里撰写内容，停下输入后自动保存。选中一段文字，可在右侧让 AI 处理。"
                maxLength={200000}
                readOnly={read.document.origin === 'import'}
                value={draft.content}
                onChange={(e) => {
                  setValue({ ...draft, content: e.target.value });
                  setSelection(undefined);
                }}
                onSelect={(e) => {
                  const el = e.currentTarget;
                  if (el.selectionEnd > el.selectionStart)
                    setSelection({
                      start: el.selectionStart,
                      end: el.selectionEnd,
                      text: el.value.slice(el.selectionStart, el.selectionEnd),
                    });
                }}
              />
            )}
            {!!read.changedSourceIds?.length && (
              <p className="muted" role="status">
                来源有新版本，当前正文仍保留原版本的加工结果。可让 AI 重新处理并另存草稿。
              </p>
            )}
            {!!read.missingSourceIds.length && (
              <p className="muted">部分来源已删除，来源记录仍保留。</p>
            )}
            {!!read.document.sources.length && (
              <details>
                <summary>来源 · {read.document.sources.length}</summary>
                {read.document.sources.map((s) => (
                  <div key={s.id}>
                    {s.title} {s.version ? `· v${s.version}` : ''}
                  </div>
                ))}
              </details>
            )}
            {!!read.backlinks.length && (
              <details>
                <summary>关联内容 · {read.backlinks.length}</summary>
                {read.backlinks.map((d) => (
                  <button className="text-button" key={d.id} onClick={() => onOpen(d.id)}>
                    {d.title}
                  </button>
                ))}
              </details>
            )}
          </>
        ) : (
          <p className="muted">正在载入文档…</p>
        )}
      </main>
      {showChat && (
        <aside id="content-document-chat" className="content-chat" aria-label="文档对话">
          <header>
            <strong>文档对话</strong>
            <small>{read?.document.title}</small>
          </header>
          <div className="content-chat-messages">
            {!messages.length && <p className="muted">围绕当前文档提问，或描述需要修改的内容。</p>}
            {messages
              .filter((m) => m.role !== 'tool' && m.content)
              .map((m) => (
                <div key={m.id} className={`content-chat-message ${m.role}`}>
                  <small>
                    {m.role === 'user' ? '你' : m.role === 'assistant' ? '同舟' : '运行记录'}
                  </small>
                  <Markdown
                    text={
                      m.role === 'user'
                        ? m.content.split('\n\n用户要求：\n').slice(1).join('\n\n用户要求：\n') ||
                          m.content
                        : m.content
                    }
                  />
                </div>
              ))}
            {onArtifact && (
              <ArtifactCards
                ids={messages.flatMap((m) => m.artifactIds ?? [])}
                onOpen={onArtifact}
              />
            )}
            {active && <p role="status">正在处理文档…</p>}
            {lastRun?.status === 'failed' && (
              <p role="alert" className="danger">
                {lastRun.error || '处理失败，请重试'}
              </p>
            )}
          </div>
          <div className="content-chat-compose">
            <div className="content-chat-input">
              <div className="row">
                <small title="以当前文档或选段为上下文，可按需读取同库中可访问的资料">
                  {selection ? `选中 ${selection.text.length} 字符` : '当前文档'}
                </small>
                {selection && (
                  <button className="text-button" onClick={() => setSelection(undefined)}>
                    清除选段
                  </button>
                )}
              </div>
              <textarea
                aria-label="文档处理要求"
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key !== 'Enter' ||
                    e.shiftKey ||
                    e.nativeEvent.isComposing ||
                    e.keyCode === 229
                  )
                    return;
                  e.preventDefault();
                  if (!e.repeat) sendMessage();
                }}
                placeholder="提问，或描述想如何修改文档…"
              />
              <div className="content-chat-toolbar">
                <div className="content-chat-settings">
                  <ChoicePicker
                    label="文档对话模型"
                    value={JSON.stringify([providerId, model])}
                    options={data.providers
                      .filter((p) => p.enabled !== false)
                      .flatMap((p) =>
                        p.models.map((m) => ({
                          value: JSON.stringify([p.id, m]),
                          label: p.modelLabels?.[m] ?? m,
                          detail: p.name,
                        })),
                      )}
                    placeholder="选择模型"
                    onChange={(value) => {
                      const [provider, selectedModel] = JSON.parse(value) as [string, string];
                      setProviderId(provider);
                      setModel(selectedModel);
                    }}
                    disabled={active || sending}
                    compact
                    searchable
                  />
                </div>
                {active ? (
                  <button
                    className="content-chat-send"
                    aria-label="停止处理"
                    title="停止处理"
                    onClick={() => void perform(() => api.cancel(sessionId))}
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="primary content-chat-send"
                    aria-label="发送处理要求"
                    title={sending ? '正在发送…' : '发送（Enter），Shift+Enter 换行'}
                    disabled={!prompt.trim() || !providerId || !model || sending || !read}
                    onClick={sendMessage}
                  >
                    {sending ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        </aside>
      )}
      {deleting && (
        <Modal title="删除文档" compact onClose={() => setDeleting(false)}>
          <div className="modal-content">
            <p>将删除此文档及其历史版本。由它派生的其他文档仍保留。</p>
          </div>
          <div className="modal-footer">
            <button onClick={() => setDeleting(false)}>取消</button>
            <button
              className="destructive-button"
              disabled={active || sending}
              onClick={() =>
                void perform(async () => {
                  if (pending.current) await pending.current;
                  await api.knowledgeDelete(documentId, base.current!.version);
                  localStorage.removeItem(key);
                  onDelete();
                })
              }
            >
              确认删除文档
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
