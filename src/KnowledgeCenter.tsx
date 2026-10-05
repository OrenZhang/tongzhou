import { KnowledgeGraphView } from './KnowledgeGraphView';
import { KnowledgeAssertions } from './KnowledgeAssertions';
import { MultiValueInput } from './MultiValueInput';
import { useEffect, useRef, useState } from 'react';
import {
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
import { KnowledgeFolders, wikiFolderOptions } from './KnowledgeFolders';
import { knowledgeFolderPath } from './shared/knowledge';
import { Field, Markdown, Modal } from './components';
import './knowledge.css';

const labels = { source: '笔记与原件', wiki: '整理文档', memory: '每日记忆' };
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
  const [section, setSection] = useState<'documents' | 'knowledge'>('documents');
  const [knowledgeView, setKnowledgeView] = useState<'graph' | 'daily'>('graph');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('*');
  const [kind, setKind] = useState<KnowledgeKind | 'all' | 'issues'>('all');
  const [folder, setFolder] = useState('*');
  const [moving, setMoving] = useState<{ doc: KnowledgeDocument; folderId: string }>();
  const [selected, setSelected] = useState<KnowledgeRead>();
  const [edit, setEdit] = useState<KnowledgeInput>();
  const [deleting, setDeleting] = useState<KnowledgeDocument>();
  const [reviewing, setReviewing] = useState<KnowledgeDocument>();
  const [memoryEdit, setMemoryEdit] = useState<{
    doc: KnowledgeDocument;
    entryId: string;
    content: string;
    remove?: boolean;
  }>();
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
      section === 'documents' ? folder || null : undefined,
    );
    if (token === request.current) setState(value);
  };
  useEffect(() => {
    const timer = setTimeout(() => void refresh().catch((e) => setError(String(e))), 150);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [query, project, sessionId, data.runs, kind, folder, section]);
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
      const result = await api.knowledgeRead(id);
      setSelected(result);
      if (result.document.kind === 'memory') {
        setSection('knowledge');
        setKnowledgeView('daily');
        setKind('memory');
      } else {
        setSection('documents');
        if (kind === 'memory') setKind('all');
      }
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
            folderId: doc.folderId,
            projectId: doc.projectId,
            tags: doc.tags,
            status: doc.status,
            assertions: doc.assertions,
            sourceIds: doc.sources.filter((s) => s.version).map((s) => s.id),
          }
        : {
            title: '',
            content: '',
            kind: kind === 'wiki' ? 'wiki' : 'source',
            folderId: folder !== '*' ? folder || null : undefined,
            projectId: project !== '*' && project ? project : undefined,
            tags: [],
            sourceIds: [],
            status: 'ready',
          },
    );
  };
  const visible = (state?.documents ?? []).filter(
    (d) =>
      (section === 'documents' ? d.kind !== 'memory' : d.kind === 'memory') &&
      (kind === 'all' ||
        (kind === 'issues' && state?.issues.some((i) => i.id === d.id)) ||
        d.kind === kind),
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
          <h1>智库</h1>
          <p>文档供你阅读与创作，知识与记忆供 Agent 按需查用。</p>
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
                if (result.imported[0]) {
                  setSelected(await api.knowledgeRead(result.imported[0].id));
                  setSection('documents');
                  setKind('all');
                  setFolder('*');
                }
              })
            }
          >
            <Upload size={15} />
            导入文件
          </button>
          <button className="primary" onClick={() => startEdit()}>
            <Plus size={16} />
            {kind === 'wiki' ? '新建整理文档' : '新建笔记'}
          </button>
        </div>
      </header>
      <div className="knowledge-navigation" role="tablist" aria-label="智库分区">
        <button
          role="tab"
          aria-selected={section === 'documents'}
          onClick={() => {
            setSection('documents');
            setKind('all');
            setSelected(undefined);
          }}
        >
          <FileText size={18} />
          <span>
            文档<small>笔记、原件与整理文档</small>
          </span>
        </button>
        <button
          role="tab"
          aria-selected={section === 'knowledge'}
          onClick={() => {
            setSection('knowledge');
            setKnowledgeView('graph');
            setKind('memory');
            setSelected(undefined);
          }}
        >
          <Sparkles size={18} />
          <span>
            知识与记忆<small>实体、关系与每日沉淀</small>
          </span>
        </button>
        <ChoicePicker
          label="智库空间"
          value={project}
          options={scopeOptions}
          onChange={(v) => {
            setProject(v);
            setSelected(undefined);
          }}
        />
      </div>
      <details className="knowledge-maintenance">
        <summary>
          整理与维护 <small>后台记忆 · 本地目录 · 索引</small>
        </summary>
        <div className="knowledge-settings">
          <label>
            <input
              type="checkbox"
              checked={state?.settings.autoCollect ?? true}
              disabled={!state || busy}
              onChange={(e) =>
                void action(async () => {
                  await api.knowledgeSettings({
                    ...state!.settings,
                    autoCollect: e.target.checked,
                  });
                })
              }
            />
            后台整理每日记忆
          </label>
          <span>Agent 按需检索 · 来源可追溯</span>
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
            {state?.memoryQueue.lastError && (
              <p className="danger">{state.memoryQueue.lastError}</p>
            )}
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
      </details>
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
      {section === 'knowledge' && (
        <div className="knowledge-filters knowledge-subnav">
          <button
            aria-pressed={knowledgeView === 'graph'}
            onClick={() => {
              setKnowledgeView('graph');
              setSelected(undefined);
            }}
          >
            实体与关系
          </button>
          <button
            aria-pressed={knowledgeView === 'daily'}
            onClick={() => {
              setKnowledgeView('daily');
              setKind('memory');
            }}
          >
            每日记忆
          </button>
          <span>不自动注入会话 · 保留证据与核对状态</span>
        </div>
      )}
      {section === 'knowledge' && knowledgeView === 'graph' ? (
        <KnowledgeGraphView
          api={api}
          project={project === '*' ? undefined : project}
          onOpen={open}
          scopeName={(scope) =>
            scope === 'global'
              ? '通用知识'
              : scope.startsWith('project:')
                ? (data.projects.find((p) => p.id === scope.slice(8))?.name ?? '项目')
                : (data.sessions.find((s) => s.id === scope.slice(8))?.title ?? '会话记忆')
          }
        />
      ) : (
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
              label="知识范围"
              value={project}
              options={scopeOptions}
              onChange={setProject}
            />
            <div className="knowledge-filters">
              {(
                [
                  ['all', '全部'],
                  ...(section === 'documents'
                    ? ([
                        ['source', '笔记与原件'],
                        ['wiki', '整理文档'],
                      ] as const)
                    : ([['memory', '每日记忆']] as const)),
                  ['issues', '待整理'],
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
            {section === 'documents' && (
              <KnowledgeFolders
                api={api}
                folders={state?.folders ?? []}
                selected={folder}
                onSelect={(id) => {
                  setFolder(id);
                  setSelected(undefined);
                }}
                onChanged={async () => {
                  setSelected(undefined);
                  await refresh();
                }}
              />
            )}
            {kind === 'source' && (
              <p className="knowledge-section-hint">
                原件保留证据，笔记记录想法；整理文档保留结论和来源，结构化知识可由 Agent 按需检索。
              </p>
            )}
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
          <main
            className="knowledge-reader"
            key={doc?.id ?? 'empty'}
            tabIndex={0}
            aria-label="知识内容"
          >
            {doc ? (
              <>
                <div className="knowledge-document-heading">
                  <div>
                    <span className={`knowledge-type ${doc.kind}`}>{labels[doc.kind]}</span>
                    <span className="knowledge-status">
                      {statuses[doc.status]} · v{doc.version}
                    </span>
                    <h2>{doc.title}</h2>
                    {doc.kind !== 'memory' && (
                      <p className="knowledge-section-hint">
                        {knowledgeFolderPath(state?.folders ?? [], doc.folderId) || '未分类'}
                      </p>
                    )}
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
                    className="secondary"
                    disabled={
                      busy || !session || doc.status === 'archived' || doc.indexed === false
                    }
                    title={
                      !session
                        ? '请先在会话中选择模型'
                        : '用当前会话模型生成整理文档与结构化知识草稿'
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
                  {doc.kind !== 'memory' && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setError('');
                        setMoving({ doc, folderId: doc.folderId ?? '' });
                      }}
                    >
                      <FolderOpen size={14} />
                      移动到目录
                    </button>
                  )}
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => setDeleting(doc)}
                  >
                    <Trash2 size={14} />
                    永久删除
                  </button>
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
                  <Markdown
                    text={doc.content || '尚未填写内容。'}
                    onKnowledgeLink={(target) => {
                      const link = selected.links.find((l) => l.target === target);
                      if (link?.id) open(link.id);
                      else
                        setError(
                          link?.ambiguous
                            ? '存在同名文档，请使用 [[文档ID|显示名称]] 精确关联。'
                            : '关联文档不存在或已删除。',
                        );
                    }}
                  />
                </article>
                {!!doc.memoryEntries?.length && (
                  <details className="ontology-editor">
                    <summary>维护记忆条目 · {doc.memoryEntries.length}</summary>
                    {doc.memoryEntries.map((e) => (
                      <div className="ontology-fact" key={e.id}>
                        <strong>{e.subject}</strong>
                        <p>{e.content}</p>
                        <button
                          className="text-button"
                          onClick={() => setMemoryEdit({ doc, entryId: e.id, content: e.content })}
                        >
                          修正此条记忆
                        </button>
                        <button
                          className="text-button danger"
                          onClick={() =>
                            setMemoryEdit({ doc, entryId: e.id, content: e.content, remove: true })
                          }
                        >
                          移除此条记忆
                        </button>
                      </div>
                    ))}
                  </details>
                )}
                <div className="knowledge-provenance">
                  {!!selected.links.length && (
                    <>
                      <h3>文档链接</h3>
                      {selected.links.map((l) => (
                        <button
                          className="text-button"
                          key={l.target}
                          disabled={!l.id}
                          onClick={() => open(l.id!)}
                        >
                          {l.target}
                          {!l.id ? (l.ambiguous ? ' · 同名待确认' : ' · 未找到') : ''}
                        </button>
                      ))}
                    </>
                  )}
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
                    <span>Agent 按任务检索、阅读</span>
                  </div>
                </div>
                <button className="primary" onClick={() => startEdit()}>
                  <Plus size={15} />
                  写第一条笔记
                </button>
                <small>
                  文本文件可全文检索；其他文件保存原件并标记为待提取。AI 草稿需核对。Agent
                  会根据任务自行检索和阅读所需内容。
                </small>
              </div>
            )}
          </main>
        </div>
      )}
      {memoryEdit && (
        <Modal
          title={memoryEdit.remove ? '移除记忆条目' : '修正记忆条目'}
          compact
          onClose={() => !busy && setMemoryEdit(undefined)}
        >
          <div className="modal-content">
            <p className="muted">
              {memoryEdit.remove
                ? '从当前记忆中移除，修订历史仍保留；当天后台不会原样补回此条。'
                : '核对后修正内容，保留来源和修订历史。'}
            </p>
            {memoryEdit.remove ? (
              <p>{memoryEdit.content}</p>
            ) : (
              <textarea
                aria-label="修正记忆内容"
                value={memoryEdit.content}
                onChange={(e) => setMemoryEdit({ ...memoryEdit, content: e.target.value })}
              />
            )}{' '}
            {error && <p className="error">{error}</p>}
          </div>
          <div className="modal-footer">
            <button className="secondary" disabled={busy} onClick={() => setMemoryEdit(undefined)}>
              取消
            </button>
            <button
              className={memoryEdit.remove ? 'destructive-button' : 'primary'}
              disabled={busy || !memoryEdit.content.trim()}
              onClick={() =>
                void action(async () => {
                  await api.knowledgeMemoryEdit(
                    memoryEdit.doc.id,
                    memoryEdit.doc.version,
                    memoryEdit.entryId,
                    memoryEdit.remove ? null : memoryEdit.content,
                  );
                  setSelected(await api.knowledgeRead(memoryEdit.doc.id));
                  setMemoryEdit(undefined);
                  setNotice('记忆已更新');
                })
              }
            >
              {memoryEdit.remove ? '确认移除' : '核对并保存'}
            </button>
          </div>
        </Modal>
      )}
      {reviewing && (
        <Modal title="核对并收录" compact onClose={() => !busy && setReviewing(undefined)}>
          <div className="modal-content confirmation-content">
            <p>
              确认已阅读“<strong>{reviewing.title}</strong>”并对照来源核对内容？
            </p>
            <p className="muted">
              核对状态会供 Agent 查阅时参考。来源变更会再次提示复核；后台新增记忆仍会标记待核对。
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
              这份资料的正文、智库中的上传原件和全部修订历史将被删除，删除后无法撤销。原始上传位置的文件不受影响。
            </p>
            <p className="muted">
              删除后 Agent 无法再检索此内容；引用它的其他知识页仍保留，并标记来源已删除。
            </p>
            {deleting.memoryDate ? (
              <p className="muted">删除后，后台不会重新生成这一天的记忆。</p>
            ) : deleting.runId ? (
              <p className="muted">这条会话记忆不会再次自动收集。</p>
            ) : null}
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
      {moving && (
        <Modal title="移动 整理文档" compact onClose={() => !busy && setMoving(undefined)}>
          <div className="modal-content wiki-folder-editor">
            <p>{moving.doc.title}</p>
            <Field label="目标目录">
              <ChoicePicker
                label="文档目标目录"
                searchable
                value={moving.folderId}
                options={wikiFolderOptions(state?.folders ?? [])}
                onChange={(folderId) => setMoving({ ...moving, folderId })}
              />
            </Field>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button className="secondary" disabled={busy} onClick={() => setMoving(undefined)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy || moving.folderId === (moving.doc.folderId ?? '')}
              onClick={() =>
                void action(async () => {
                  const moved = await api.knowledgeMove(
                    moving.doc.id,
                    moving.folderId || null,
                    moving.doc.version,
                  );
                  setSelected(await api.knowledgeRead(moved.id));
                  if (kind === 'wiki') setFolder(moved.folderId ?? '');
                  setMoving(undefined);
                  setNotice('整理文档已移动，正文与来源引用已保留');
                })
              }
            >
              确认移动
            </button>
          </div>
        </Modal>
      )}
      {edit && (
        <Modal
          title={edit.id ? '编辑知识资料' : edit.kind === 'wiki' ? '新建整理文档' : '新建笔记'}
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
                    { value: 'source', label: '资料来源 / 原始笔记' },
                    { value: 'wiki', label: '整理文档' },
                  ]}
                  onChange={(kind) =>
                    setEdit({
                      ...edit,
                      kind: kind as KnowledgeKind,
                      folderId: edit.folderId,
                    })
                  }
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
              {edit.kind !== 'memory' && (
                <Field label="文档目录">
                  <ChoicePicker
                    label="文档所属目录"
                    searchable
                    value={edit.folderId ?? ''}
                    options={wikiFolderOptions(state?.folders ?? [])}
                    onChange={(folderId) => setEdit({ ...edit, folderId: folderId || null })}
                  />
                </Field>
              )}
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
            <KnowledgeAssertions
              value={edit.assertions ?? []}
              onChange={(assertions) => setEdit({ ...edit, assertions })}
              sources={(state?.documents ?? []).filter((d) => edit.sourceIds?.includes(d.id))}
            />
            {edit.kind !== 'memory' && (
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
                已核对内容与来源
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
                  setSection('documents');
                  setKind('all');
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
