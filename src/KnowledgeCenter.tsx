import { MultiValueInput } from './MultiValueInput';
import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Check,
  FileText,
  FolderOpen,
  History,
  Link2,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
  Trash2,
} from 'lucide-react';
import type { Session, Snapshot, TongzhouAPI } from './shared/types';
import type {
  KnowledgeDocument,
  KnowledgeInput,
  KnowledgeKind,
  KnowledgeRead,
  KnowledgeState,
} from './shared/knowledge';
import { ChoicePicker } from './ChoicePicker';
import { Field, Markdown, Modal } from './components';
import './knowledge.css';

const labels = { source: '资料', wiki: 'Wiki', memory: '记忆' };
const statuses = { ready: '已收录', draft: '待核对', archived: '已归档' };
export function KnowledgeCenter({
  api,
  data,
  sessionId,
  onSession,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  sessionId: string;
  onSession(session: Session): void;
}) {
  const [state, setState] = useState<KnowledgeState>();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('*');
  const [kind, setKind] = useState<KnowledgeKind | 'all' | 'issues' | 'archived'>('all');
  const [selected, setSelected] = useState<KnowledgeRead>();
  const [edit, setEdit] = useState<KnowledgeInput>();
  const [deleting, setDeleting] = useState<KnowledgeDocument>();
  const [reviewing, setReviewing] = useState<KnowledgeDocument>();
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const session = data.sessions.find((s) => s.id === sessionId && !s.archived);
  const refresh = async () => {
    const token = ++request.current;
    const value = await api.knowledgeState(
      query,
      project === '*' ? undefined : project,
      sessionId || undefined,
    );
    if (token === request.current) setState(value);
  };
  useEffect(() => {
    const timer = setTimeout(() => void refresh().catch((e) => setError(String(e))), 150);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [query, project, sessionId, data.runs]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : String(e)).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          '',
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const open = (id: string) =>
    void action(async () => {
      setSelected(await api.knowledgeRead(id));
    });
  const startEdit = (doc?: KnowledgeDocument) => {
    setPreview(false);
    setEdit(
      doc
        ? {
            id: doc.id,
            version: doc.version,
            title: doc.title,
            content: doc.content,
            kind: doc.kind,
            projectId: doc.projectId,
            tags: doc.tags,
            status: doc.status,
            sourceIds: doc.sources.filter((s) => s.version).map((s) => s.id),
          }
        : {
            title: '',
            content: '',
            kind: 'source',
            projectId: project !== '*' && project ? project : undefined,
            tags: [],
            sourceIds: [],
            status: 'ready',
          },
    );
  };
  const visible =
    kind === 'archived'
      ? (state?.archived ?? [])
      : (state?.documents ?? []).filter(
          (d) =>
            kind === 'all' ||
            (kind === 'issues' && state?.issues.some((i) => i.id === d.id)) ||
            d.kind === kind,
        );
  const doc = selected?.document;
  const scopeOptions = [
    { value: '*', label: '全部空间' },
    { value: '', label: '通用资料与普通会话' },
    ...data.projects
      .filter((p) => !p.sourceProjectId && !p.removed)
      .map((p) => ({ value: p.id, label: p.name })),
  ];
  return (
    <section className="page knowledge-page">
      <header className="page-heading">
        <div>
          <div className="knowledge-eyebrow">
            <BookOpen size={14} /> LOCAL KNOWLEDGE
          </div>
          <h1>知识库</h1>
          <p>把资料、项目经验和会话发现，积累成可复用的知识。</p>
        </div>
        <div className="row">
          <button
            className="secondary"
            disabled={busy || !session}
            title="只读排查当前会话可访问的知识"
            onClick={() =>
              void action(async () => {
                const id = await api.knowledgeAudit(session!.id);
                onSession((await api.snapshot()).sessions.find((s) => s.id === id)!);
              })
            }
          >
            <Search size={15} />
            Agent 排查
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await api.knowledgeImport(
                  project !== '*' && project ? project : undefined,
                );
                setNotice(
                  `已导入 ${result.imported.length} 份资料${result.errors.length ? '；' + result.errors.join('；') : ''}`,
                );
                if (result.imported[0]) setSelected(await api.knowledgeRead(result.imported[0].id));
              })
            }
          >
            <Upload size={15} />
            导入文件
          </button>
          <button className="primary" onClick={() => startEdit()}>
            <Plus size={16} />
            新建笔记
          </button>
        </div>
      </header>
      <div className="knowledge-settings">
        <label>
          <input
            type="checkbox"
            checked={state?.settings.autoCollect ?? true}
            disabled={!state || busy}
            onChange={(e) =>
              void action(async () => {
                await api.knowledgeSettings({ ...state!.settings, autoCollect: e.target.checked });
              })
            }
          />
          后台整理每日记忆
        </label>
        <label>
          <input
            type="checkbox"
            checked={state?.settings.autoContext ?? true}
            disabled={!state || busy}
            onChange={(e) =>
              void action(async () => {
                await api.knowledgeSettings({ ...state!.settings, autoContext: e.target.checked });
              })
            }
          />
          按需引用知识
        </label>
        <span>本地存储 · 来源可追溯</span>
        <button
          className="text-button"
          disabled={busy || !session}
          title="把当前会话最近 100 个已完成轮次加入待整理队列，不直接生成记忆"
          onClick={() =>
            void action(async () => {
              const result = await api.knowledgeCollect(session!.id);
              setNotice(`已加入 ${result.collected} 个候选轮次，后台整理后归并到每日记忆`);
            })
          }
        >
          <History size={14} />
          补收当前会话
        </button>
        <button
          className="text-button"
          onClick={() => void action(async () => api.knowledgeOpenFolder())}
        >
          <FolderOpen size={14} />
          打开目录
        </button>
        <button
          className="icon-button"
          aria-label="重建知识索引"
          title="重建知识索引"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const result = await api.knowledgeReindex();
              setNotice(`已重建 ${result.indexed} 份资料的索引`);
            })
          }
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="knowledge-memory-status">
        <div>
          <strong>每日记忆 · 空闲后整理</strong>
          <p>
            按本地日期每天一份，分类保留有证据的偏好、事实、决策、经验、待办和矛盾。复用来源会话的模型，会消耗该模型额度。
          </p>
          <small>
            待整理 {state?.memoryQueue.pending ?? 0} · 整理中 {state?.memoryQueue.running ?? 0} ·
            失败 {state?.memoryQueue.failed ?? 0}
          </small>
          {state?.memoryQueue.lastError && <p className="danger">{state.memoryQueue.lastError}</p>}
          {state?.memoryQueue.lastResult && <p>{state.memoryQueue.lastResult}</p>}
        </div>
        <button
          className="secondary"
          disabled={busy || !state?.settings.autoCollect || !!state?.memoryQueue.running}
          onClick={() =>
            void action(async () => {
              const result = await api.knowledgeMemoryProcess(true);
              setNotice(
                result.started
                  ? '后台记忆 Agent 已开始整理一批候选资料'
                  : '暂未启动：可能有其他任务运行、没有候选资料或连接不可用，请查看队列状态',
              );
            })
          }
        >
          <Sparkles size={14} />
          {state?.memoryQueue.failed ? '重试整理' : '立即整理'}
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="knowledge-notice" role="status">
          {notice}
        </div>
      )}
      <div className="knowledge-layout">
        <aside className="knowledge-library">
          <label className="knowledge-search">
            <Search size={15} />
            <input
              aria-label="搜索知识"
              placeholder="搜索标题或正文…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <ChoicePicker
            label="知识空间"
            value={project}
            options={scopeOptions}
            onChange={setProject}
          />
          <div className="knowledge-filters">
            {(
              [
                ['all', '全部'],
                ['source', '资料'],
                ['wiki', 'Wiki'],
                ['memory', '每日记忆'],
                ['issues', '待整理'],
                ['archived', '归档'],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>
                {label}
                {value === 'issues' && !!state?.issues.length && (
                  <small>{state.issues.length}</small>
                )}
              </button>
            ))}
          </div>
          <div className="knowledge-list" aria-label="知识资料列表">
            {visible.map((d) => (
              <button
                key={d.id}
                className={'knowledge-item' + (doc?.id === d.id ? ' selected' : '')}
                onClick={() => open(d.id)}
              >
                <div>
                  <span className={`knowledge-type ${d.kind}`}>{labels[d.kind]}</span>
                  <small>{statuses[d.status]}</small>
                </div>
                <strong>{d.title}</strong>
                <p>{d.excerpt.replace(/[#*`]/g, '').slice(0, 100) || '暂无正文'}</p>
                <small>
                  {data.projects.find((p) => p.id === d.projectId)?.name ??
                    (d.sessionId ? '会话资料' : '通用资料')}{' '}
                  · {new Date(d.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))}
            {!visible.length && (
              <div className="knowledge-list-empty">
                {query ? '没有匹配的资料' : '这里还没有资料'}
              </div>
            )}
          </div>
          <small className="knowledge-count">
            {visible.length} 项结果 · 共 {state?.total ?? 0} 份资料
          </small>
        </aside>
        <main className="knowledge-reader">
          {doc ? (
            <>
              <div className="knowledge-document-heading">
                <div>
                  <span className={`knowledge-type ${doc.kind}`}>{labels[doc.kind]}</span>
                  <span className="knowledge-status">
                    {statuses[doc.status]} · v{doc.version}
                  </span>
                  <h2>{doc.title}</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="关闭知识详情"
                  onClick={() => setSelected(undefined)}
                >
                  <ArrowLeft size={16} />
                </button>
              </div>
              <div className="knowledge-document-actions">
                {doc.status !== 'archived' &&
                  (doc.status === 'draft' ||
                    state?.issues.some((issue) => issue.id === doc.id)) && (
                    <button
                      className="primary"
                      disabled={busy || doc.indexed === false}
                      onClick={() => {
                        setError('');
                        setReviewing(doc);
                      }}
                    >
                      <Check size={14} />
                      核对并收录
                    </button>
                  )}
                <button
                  className="secondary action-emphasis"
                  disabled={busy || !session || doc.status === 'archived'}
                  title={session ? `引用到：${session.title}` : '先打开一个会话，再选择参考资料'}
                  onClick={() =>
                    void action(async () => {
                      const pinned = state?.pinned ?? [];
                      const selected = pinned.includes(doc.id);
                      await api.knowledgeBind(
                        session!.id,
                        selected ? pinned.filter((id) => id !== doc.id) : [...pinned, doc.id],
                      );
                      setNotice(
                        selected ? '已取消此会话引用' : `已引用到「${session!.title}」，下一轮生效`,
                      );
                    })
                  }
                >
                  <Link2 size={14} />
                  {state?.pinned.includes(doc.id) ? '取消会话引用' : '引用到当前会话'}
                </button>
                <button
                  className="secondary"
                  disabled={busy || !session || doc.status === 'archived' || doc.indexed === false}
                  title={
                    !session ? '请先在会话中选择模型' : '用当前会话模型整理为有来源的 Wiki 草稿'
                  }
                  onClick={() =>
                    void action(async () => {
                      const id = await api.knowledgeOrganize(session!.id, [doc.id]);
                      const snapshot = await api.snapshot();
                      onSession(snapshot.sessions.find((s) => s.id === id)!);
                    })
                  }
                >
                  <Sparkles size={14} />让 Agent 整理
                </button>
                {doc.kind !== 'memory' && doc.status !== 'archived' && (
                  <button className="text-button" onClick={() => startEdit(doc)}>
                    <NotebookPen size={14} />
                    {doc.origin === 'import' ? '编辑信息' : '编辑'}
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api.knowledgeArchive(doc.id, doc.status !== 'archived');
                      setSelected(await api.knowledgeRead(doc.id));
                    })
                  }
                >
                  <Archive size={14} />
                  {doc.status === 'archived' ? '恢复资料' : '归档'}
                </button>
                {doc.status === 'archived' && (
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => setDeleting(doc)}
                  >
                    <Trash2 size={14} />
                    永久删除
                  </button>
                )}
              </div>
              {!!state?.issues.some((i) => i.id === doc.id) && (
                <div className="knowledge-review-note">
                  {state.issues
                    .filter((i) => i.id === doc.id)
                    .map((i) => (
                      <p key={i.reason}>{i.reason}</p>
                    ))}
                </div>
              )}
              {!!doc.tags.length && (
                <div className="knowledge-tags">
                  {doc.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              )}
              {!!selected.outline.length && (
                <details className="knowledge-outline">
                  <summary>文档目录 · {selected.outline.length} 节</summary>
                  {selected.outline.map((h) => (
                    <div key={h.line} style={{ paddingLeft: (h.level - 1) * 12 }}>
                      {h.title}
                      <small>第 {h.line} 行</small>
                    </div>
                  ))}
                </details>
              )}
              <article className="knowledge-content">
                <Markdown text={doc.content || '尚未填写内容。'} />
              </article>
              <div className="knowledge-provenance">
                <h3>来源与关联</h3>
                {!doc.sources.length && <p>手写或导入的原始资料，可作为后续知识页的来源。</p>}
                {doc.sources.map((source, index) =>
                  source.messageId ? (
                    <button
                      className="text-button"
                      key={index}
                      disabled={!data.sessions.some((s) => s.id === source.sessionId)}
                      onClick={() => {
                        const session = data.sessions.find((s) => s.id === source.sessionId);
                        if (session) onSession(session);
                      }}
                    >
                      {source.title} · 原会话
                    </button>
                  ) : (
                    <button
                      className="text-button"
                      key={index}
                      disabled={selected.missingSourceIds.includes(source.id)}
                      onClick={() => open(source.id)}
                    >
                      <FileText size={13} />
                      {source.title} ·{' '}
                      {selected.missingSourceIds.includes(source.id)
                        ? '来源已删除'
                        : `v${source.version}`}
                    </button>
                  ),
                )}
                {!!selected.backlinks.length && (
                  <>
                    <h3>引用此资料的知识页</h3>
                    {selected.backlinks.map((d) => (
                      <button className="text-button" key={d.id} onClick={() => open(d.id)}>
                        {d.title}
                      </button>
                    ))}
                  </>
                )}
                {!!selected.revisions.length && (
                  <details>
                    <summary>
                      <History size={13} />
                      修订历史 · {selected.revisions.length}
                    </summary>
                    {selected.revisions.map((rev) => (
                      <div className="knowledge-revision" key={rev.id}>
                        <span>
                          v{rev.version} · {new Date(rev.updatedAt).toLocaleString()}
                        </span>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await api.knowledgeRestore(doc.id, rev.version, doc.version);
                              setSelected(await api.knowledgeRead(doc.id));
                              setNotice('已恢复历史内容，恢复前版本仍保留');
                            })
                          }
                        >
                          恢复此版本
                        </button>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            </>
          ) : (
            <div className="knowledge-welcome">
              <div className="knowledge-welcome-icon">
                <BookOpen size={30} />
              </div>
              <h2>让每次工作，都留下积累</h2>
              <p>导入参考文件，记下一个想法，或让 Agent 从会话中整理知识。</p>
              <div className="knowledge-steps">
                <div>
                  <FileText size={19} />
                  <strong>保留资料</strong>
                  <span>上传文件与手写笔记</span>
                </div>
                <div>
                  <Sparkles size={19} />
                  <strong>整理知识</strong>
                  <span>关联来源，持续补充</span>
                </div>
                <div>
                  <Link2 size={19} />
                  <strong>用于任务</strong>
                  <span>检索、引用到会话</span>
                </div>
              </div>
              <button className="primary" onClick={() => startEdit()}>
                <Plus size={15} />
                写第一条笔记
              </button>
              <small>
                文本文件可全文检索；其他文件保存原件并标记为待提取。AI
                草稿需核对，确认后才参与自动上下文引用。
              </small>
            </div>
          )}
        </main>
      </div>
      {reviewing && (
        <Modal title="核对并收录" compact onClose={() => !busy && setReviewing(undefined)}>
          <div className="modal-content confirmation-content">
            <p>
              确认已阅读“<strong>{reviewing.title}</strong>”并对照来源核对内容？
            </p>
            <p className="muted">
              收录后可参与按需引用。来源变更会再次提示复核；后台新增记忆仍会标记待核对。
            </p>
            {!!reviewing.sources.length && (
              <ul>
                {reviewing.sources.slice(0, 12).map((source) => (
                  <li key={source.id}>
                    {source.title}
                    {source.version ? ` · v${source.version}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button className="secondary" disabled={busy} onClick={() => setReviewing(undefined)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api.knowledgeReview(reviewing.id, reviewing.version);
                  setSelected(await api.knowledgeRead(reviewing.id));
                  setReviewing(undefined);
                  setNotice('已核对并收录');
                })
              }
            >
              确认已核对
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="永久删除资料" compact onClose={() => !busy && setDeleting(undefined)}>
          <div className="modal-content confirmation-content">
            <p>
              确认永久删除“<strong>{deleting.title}</strong>”？
            </p>
            <p className="muted">
              这份资料的正文、知识库中的上传原件和全部修订历史将被删除，无法通过恢复资料撤销。原始上传位置的文件不受影响。
            </p>
            <p className="muted">会话引用将被取消；引用它的其他知识页仍保留，并标记来源已删除。</p>
            {deleting.runId && <p className="muted">这条会话记忆不会再次自动收集。</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button className="secondary" disabled={busy} onClick={() => setDeleting(undefined)}>
              取消
            </button>
            <button
              className="destructive-button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api.knowledgeDelete(deleting.id, deleting.version);
                  setSelected(undefined);
                  setDeleting(undefined);
                  setNotice('资料已永久删除');
                })
              }
            >
              {busy ? '删除中…' : '确认永久删除'}
            </button>
          </div>
        </Modal>
      )}
      {edit && (
        <Modal
          title={edit.id ? '编辑知识资料' : '新建笔记'}
          wide
          onClose={() => !busy && setEdit(undefined)}
        >
          <div className="modal-content knowledge-editor">
            <div className="form-grid">
              <Field label="标题">
                <input
                  aria-label="知识标题"
                  value={edit.title}
                  onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                />
              </Field>
              <Field label="类型">
                <ChoicePicker
                  label="知识类型"
                  value={edit.kind}
                  disabled={!!edit.id}
                  options={[
                    { value: 'source', label: '资料 / 手写笔记' },
                    { value: 'wiki', label: 'Wiki 知识页' },
                  ]}
                  onChange={(kind) => setEdit({ ...edit, kind: kind as KnowledgeKind })}
                />
              </Field>
              <Field label="归属空间">
                <ChoicePicker
                  label="笔记归属空间"
                  value={edit.projectId ?? ''}
                  options={scopeOptions.filter((o) => o.value !== '*')}
                  onChange={(projectId) => setEdit({ ...edit, projectId: projectId || undefined })}
                />
              </Field>
              <Field label="标签">
                <MultiValueInput
                  label="知识标签"
                  value={edit.tags ?? []}
                  onChange={(tags) => setEdit({ ...edit, tags })}
                />
              </Field>
            </div>
            <div className="knowledge-edit-tabs">
              <button aria-pressed={!preview} onClick={() => setPreview(false)}>
                Markdown
              </button>
              <button aria-pressed={preview} onClick={() => setPreview(true)}>
                预览
              </button>
            </div>
            {preview ? (
              <div className="knowledge-edit-preview">
                <Markdown text={edit.content || '暂无内容'} />
              </div>
            ) : (
              <textarea
                aria-label="知识正文"
                value={edit.content}
                readOnly={doc?.id === edit.id && doc?.origin === 'import'}
                placeholder="写下内容、结论、适用范围，或仍需要确认的问题…"
                onChange={(e) => setEdit({ ...edit, content: e.target.value })}
              />
            )}
            {edit.kind === 'wiki' && (
              <details className="knowledge-source-options">
                <summary>关联来源 · {edit.sourceIds?.length ?? 0}</summary>
                {state?.documents
                  .filter((d) => d.id !== edit.id)
                  .map((d) => (
                    <label key={d.id}>
                      <input
                        type="checkbox"
                        checked={edit.sourceIds?.includes(d.id) ?? false}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            sourceIds: e.target.checked
                              ? [...(edit.sourceIds ?? []), d.id]
                              : (edit.sourceIds ?? []).filter((id) => id !== d.id),
                          })
                        }
                      />
                      {d.title}
                    </label>
                  ))}
              </details>
            )}
            {edit.kind === 'wiki' && (
              <label className="knowledge-confirm">
                <input
                  type="checkbox"
                  checked={edit.status === 'ready'}
                  onChange={(e) =>
                    setEdit({ ...edit, status: e.target.checked ? 'ready' : 'draft' })
                  }
                />
                已核对内容，允许按需引用到会话
              </label>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button className="secondary" disabled={busy} onClick={() => setEdit(undefined)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !edit.title.trim()}
              onClick={() =>
                void action(async () => {
                  const saved = await api.knowledgeSave(edit);
                  setSelected(await api.knowledgeRead(saved.id));
                  setEdit(undefined);
                  setNotice('资料已保存到本地');
                })
              }
            >
              <Check size={15} />
              保存资料
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function KnowledgeReferences({
  api,
  sessionId,
  onOpen,
}: {
  api: TongzhouAPI;
  sessionId: string;
  onOpen(): void;
}) {
  const [value, setValue] = useState<Awaited<ReturnType<TongzhouAPI['knowledgeReferenceState']>>>();
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      void api
        .knowledgeReferenceState(sessionId)
        .then((result) => {
          if (active) setValue(result);
        })
        .catch(() => {});
    load();
    const off = api.onEvent((e) => {
      if (e.type === 'changed') load();
    });
    return () => {
      active = false;
      off();
    };
  }, [sessionId]);
  return (
    <>
      <button
        className="text-button knowledge-reference-button"
        onClick={() => setOpened(true)}
        title="查看本轮实际引用、管理后续引用"
      >
        <BookOpen size={14} />
        知识
        {value?.references.length
          ? ' · ' + value.references.length + ' 份引用'
          : value?.pinned.length
            ? ' · ' + value.pinned.length + ' 份已选'
            : ''}
      </button>
      {opened && (
        <Modal title="会话知识引用" onClose={() => setOpened(false)}>
          <div className="modal-content knowledge-reference-list">
            <p className="muted">
              以下是最近一轮实际注入或通过工具读取的片段。排除操作从下一轮生效，不会撤回已发送内容；明确要求时
              Agent 仍可通过工具读取。
            </p>
            {!value?.references.length && (
              <p>本轮尚未引用知识。发送相关问题后，会在这里显示自动检索和工具读取的资料。</p>
            )}
            {value?.references.map((reference) => (
              <article key={reference.id}>
                <div className="row">
                  <strong>{reference.title}</strong>
                  <span className="muted">
                    v{reference.version} ·{' '}
                    {
                      { explicit: '手动引用', automatic: '自动检索', tool: '工具读取' }[
                        reference.mode
                      ]
                    }
                  </span>
                </div>
                <details>
                  <summary>查看实际片段</summary>
                  <pre>{reference.excerpt}</pre>
                </details>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      await api.knowledgeExclude(
                        sessionId,
                        reference.id,
                        !value.excluded.includes(reference.id),
                      );
                      setValue(await api.knowledgeReferenceState(sessionId));
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {value.excluded.includes(reference.id) ? '恢复后续引用' : '下轮不再注入'}
                </button>
              </article>
            ))}
            {!!value?.excluded.length && (
              <details>
                <summary>已排除 {value.excluded.length} 份资料</summary>
                {value.excluded.map((id) => (
                  <button
                    className="text-button"
                    key={id}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api.knowledgeExclude(sessionId, id, false);
                        setValue(await api.knowledgeReferenceState(sessionId));
                      } catch (e) {
                        setError(String(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    恢复引用 · {value.references.find((r) => r.id === id)?.title ?? id}
                  </button>
                ))}
              </details>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              onClick={() => {
                setOpened(false);
                onOpen();
              }}
            >
              打开知识库管理引用
            </button>
            <button className="primary" onClick={() => setOpened(false)}>
              完成
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
