import { useEffect, useRef, useState } from 'react';
import { ArtifactCards } from '../artifacts/Artifacts';
import type { KnowledgeDocument, KnowledgeFolder, KnowledgeRead } from '../../shared/knowledge';
import type { Message, Snapshot, TongzhouAPI } from '../../shared/types';
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
  onInspect,
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
  onInspect(): void;
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
  const [preview, setPreview] = useState(false);
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [providerId, setProviderId] = useState(
    data.providers.find((p) => p.enabled !== false)?.id ?? '',
  );
  const [model, setModel] = useState(
    data.providers.find((p) => p.enabled !== false)?.models[0] ?? '',
  );
  const [agentId, setAgentId] = useState('');
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
            <input
              className="content-title"
              aria-label="文档标题"
              maxLength={180}
              readOnly={read.document.origin === 'import'}
              value={draft.title}
              onChange={(e) => setValue({ ...draft, title: e.target.value })}
            />
            <div className="content-editor-actions">
              <small role="status">
                {status} · v{base.current?.version}
              </small>
              <button className="text-button" onClick={() => setPreview(!preview)}>
                {preview ? '编辑正文' : '预览'}
              </button>
              <button
                className="text-button"
                disabled={read.document.origin === 'import'}
                onClick={() => void perform(save)}
              >
                保存
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void perform(async () => {
                    await save();
                    await api.contentReady(documentId, base.current!.version);
                    setStatus('当前版本已就绪，匹配的自动化已加入队列');
                  })
                }
              >
                标记就绪
              </button>
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
              <button
                className="text-button"
                onClick={() =>
                  void perform(async () => {
                    await save();
                    onInspect();
                  })
                }
              >
                来源与整理
              </button>
              <button className="text-button danger" onClick={() => setDeleting(true)}>
                删除
              </button>
            </div>
            <div className="content-location">
              <label>
                目录{' '}
                <select
                  aria-label="文档目录"
                  value={read.document.folderId ?? ''}
                  onChange={(e) =>
                    void perform(async () => {
                      await save();
                      await api.knowledgeMove(
                        documentId,
                        e.target.value || null,
                        base.current!.version,
                      );
                      await load(true);
                      await onChange();
                    })
                  }
                >
                  <option value="">未分类</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {knowledgeFolderPath(folders, f.id)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
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
              <article className="content-body-preview">
                <Markdown text={draft.content} />
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
          <div className="content-chat-settings">
            <select
              aria-label="文档对话连接"
              value={providerId}
              disabled={active || sending}
              onChange={(e) => {
                setProviderId(e.target.value);
                setModel(data.providers.find((p) => p.id === e.target.value)?.models[0] ?? '');
              }}
            >
              <option value="">选择模型连接</option>
              {data.providers
                .filter((p) => p.enabled !== false)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <select
              aria-label="文档对话模型"
              value={model}
              disabled={active || sending}
              onChange={(e) => setModel(e.target.value)}
            >
              {data.providers
                .find((p) => p.id === providerId)
                ?.models.map((m) => (
                  <option key={m} value={m}>
                    {data.providers.find((p) => p.id === providerId)?.modelLabels?.[m] ?? m}
                  </option>
                ))}
            </select>
            <select
              aria-label="文档处理 Agent"
              value={agentId}
              disabled={active || sending}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="">同舟 · 通用助手</option>
              {data.agents
                .filter((a) => !a.builtin)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </div>
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
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如：润色选中的段落并保存；按标题拆分成多份文档…"
            />
            <div className="row">
              {active ? (
                <button
                  className="secondary"
                  onClick={() => void perform(() => api.cancel(sessionId))}
                >
                  停止处理
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!prompt.trim() || !providerId || !model || sending || !read}
                  onClick={() =>
                    void perform(async () => {
                      setSending(true);
                      try {
                        await save();
                        const result = await api.contentRun({
                          documentId,
                          version: base.current!.version,
                          providerId,
                          model,
                          agentId,
                          prompt,
                          selection,
                        });
                        setSessionId(result.sessionId);
                        setPrompt('');
                      } finally {
                        setSending(false);
                      }
                    })
                  }
                >
                  {sending ? '正在发送…' : '发送处理要求'}
                </button>
              )}
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
