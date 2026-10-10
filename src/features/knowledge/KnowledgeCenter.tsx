import { ArtifactsCenter } from '../artifacts/Artifacts';
import { WorkspaceToolbar } from '../workspace/WorkspaceToolbar';
import { AutomationCenter } from '../automation/AutomationCenter';
import { KnowledgeGraphView } from './KnowledgeGraphView';
import { Personalization } from './Personalization';
import { ContentWorkspace } from './ContentWorkspace';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Check,
  FileText,
  FolderOpen,
  History,
  NotebookPen,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Session, Snapshot, TongzhouAPI } from '../../shared/types';
import type {
  KnowledgeDocument,
  KnowledgeKind,
  KnowledgeRead,
  KnowledgeState,
} from '../../shared/knowledge';
import { ChoicePicker } from '../../components/controls/ChoicePicker';
import { Markdown, Modal } from '../../components/components';
import './knowledge.css';

const labels = { source: '笔记与原件', wiki: '整理文档', memory: '每日记忆' };
const statuses = { ready: '已核对', draft: '待核对' };
export function KnowledgeCenter({
  api,
  data,
  sessionId,
  onSession,
  initialDocument,
  initialSection = 'workspace',
  artifactSession,
  onArtifact,
  onNewChat,
}: {
  initialDocument?: { id: string; libraryId: string };
  initialSection?: 'workspace' | 'artifacts';
  artifactSession?: string;
  onArtifact?(id: string, organize?: boolean): void;
  onNewChat(): void;
  api: TongzhouAPI;
  data: Snapshot;
  sessionId: string;
  onSession(session: Session): void;
}) {
  const [state, setState] = useState<KnowledgeState>();
  const [section, setSection] = useState<
    'workspace' | 'knowledge' | 'personalization' | 'automation' | 'artifacts'
  >(initialSection);
  useEffect(() => setSection(initialSection), [initialSection, artifactSession]);
  const [contentTarget, setContentTarget] = useState<{ id: string; libraryId: string } | undefined>(
    initialDocument?.libraryId ? initialDocument : undefined,
  );
  const [knowledgeView, setKnowledgeView] = useState<'graph' | 'daily'>('graph');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('*');
  const [kind, setKind] = useState<KnowledgeKind | 'all' | 'issues'>('all');
  const [selected, setSelected] = useState<KnowledgeRead>();
  const [deleting, setDeleting] = useState<KnowledgeDocument>();
  const [reviewing, setReviewing] = useState<KnowledgeDocument>();
  const [memoryEdit, setMemoryEdit] = useState<{
    doc: KnowledgeDocument;
    entryId: string;
    content: string;
    remove?: boolean;
  }>();
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
  }, [query, project, sessionId, data.runs, kind, section]);
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
      if (result.document.kind === 'memory') {
        setSelected(result);
        setSection('knowledge');
        setKnowledgeView('daily');
        setKind('memory');
      } else {
        setSelected(undefined);
        setContentTarget({ id, libraryId: result.document.libraryId ?? 'default' });
        setSection('workspace');
      }
    });
  useEffect(() => {
    if (initialSection === 'artifacts') return;
    if (initialDocument?.libraryId) {
      setContentTarget(initialDocument);
      setSection('workspace');
    } else if (initialDocument) open(initialDocument.id);
  }, [initialDocument, initialSection]);
  const scopedDocuments = (state?.documents ?? []).filter((d) => d.kind === 'memory');
  const issueIds = new Set(state?.issues.map((issue) => issue.id) ?? []);
  const pendingCount = scopedDocuments.filter((d) => issueIds.has(d.id)).length;
  const visible = scopedDocuments.filter(
    (d) => kind === 'all' || (kind === 'issues' && issueIds.has(d.id)) || d.kind === kind,
  );
  const doc = selected?.document;
  const scopeOptions = [
    { value: '*', label: '全部空间' },
    { value: '', label: '通用资料与普通会话' },
    ...data.projects
      .filter((p) => !p.sourceProjectId && !p.removed)
      .map((p) => ({ value: p.id, label: p.name })),
  ];
  const heading = (
    <>
      <header className="page-heading">
        <div>
          <h1>智库</h1>
          <p>文档供你阅读与创作，知识与记忆供 Agent 按需查用。</p>
        </div>
      </header>
      <div className="knowledge-navigation" role="tablist" aria-label="智库分区">
        <button
          role="tab"
          aria-selected={section === 'artifacts'}
          onClick={() => setSection('artifacts')}
        >
          <FileText size={18} />
          <span>
            作品<small>按日期查看生成成果</small>
          </span>
        </button>
        <button
          role="tab"
          aria-selected={section === 'workspace'}
          onClick={() => setSection('workspace')}
        >
          <NotebookPen size={18} />
          <span>
            内容库<small>文档编辑与 AI 协作</small>
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
        <button
          role="tab"
          aria-selected={section === 'personalization'}
          onClick={() => {
            setSection('personalization');
            setSelected(undefined);
          }}
        >
          <NotebookPen size={18} />
          <span>
            个性与偏好<small>回复方式与记住的习惯</small>
          </span>
        </button>
        <button
          role="tab"
          aria-selected={section === 'automation'}
          onClick={() => setSection('automation')}
        >
          <Sparkles size={18} />
          <span>
            AI 工作流<small>处理流程、自动化与结果</small>
          </span>
        </button>
      </div>
      {section === 'knowledge' && (
        <WorkspaceToolbar
          context={
            <ChoicePicker
              label="智库空间"
              value={project}
              options={scopeOptions}
              onChange={(v) => {
                setProject(v);
                setSelected(undefined);
              }}
            />
          }
        >
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
        </WorkspaceToolbar>
      )}
    </>
  );
  if (section === 'artifacts')
    return (
      <section className="page knowledge-page">
        {heading}
        <ArtifactsCenter
          api={api}
          data={data}
          sessionId={artifactSession}
          onOpen={(id, organize) => onArtifact?.(id, organize)}
        />
      </section>
    );
  if (section === 'automation')
    return (
      <section className="page knowledge-page">
        {heading}
        <AutomationCenter
          api={api}
          data={data}
          onSession={onSession}
          onDocument={(id, libraryId) => {
            if (!libraryId) {
              open(id);
              return;
            }
            setContentTarget({ id, libraryId });
            setSection('workspace');
          }}
        />
      </section>
    );
  if (section === 'workspace')
    return (
      <section className="page knowledge-page knowledge-content-page">
        {heading}
        <ContentWorkspace
          key={contentTarget?.libraryId ?? 'default'}
          api={api}
          data={data}
          initialDocument={contentTarget}
          onArtifact={onArtifact}
        />
      </section>
    );
  if (section === 'personalization')
    return (
      <section className="page knowledge-page">
        {heading}
        <Personalization
          api={api}
          onChat={onNewChat}
          onMemories={() => {
            setSection('knowledge');
            setKnowledgeView('daily');
            setKind('memory');
            setSelected(undefined);
          }}
        />
      </section>
    );
  return (
    <section className="page knowledge-page">
      {heading}
      <details className="knowledge-maintenance">
        <summary>
          整理与维护 <small>后台记忆 · 本地目录 · 索引</small>
        </summary>
        <div className="knowledge-settings">
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
            <strong>每日记忆 · {state?.settings.autoCollect ? '已启用' : '已暂停'}</strong>
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
            title="在自动化与定时中设置记忆整理的开关、触发方式，并查看执行记录"
            onClick={() => setSection('automation')}
          >
            <Sparkles size={14} />
            管理记忆任务
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
            <div className="knowledge-filters">
              {(
                [
                  ['all', '全部'],
                  ['memory', '每日记忆'],
                  ['issues', '待整理'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={kind === value}
                  title={
                    value === 'issues'
                      ? '当前范围内需要核对的记忆'
                      : value === 'all'
                        ? '查看当前范围内的全部记忆'
                        : '按日期查看整理的会话记忆'
                  }
                  onClick={() => setKind(value)}
                >
                  {label}
                  {value === 'issues' && pendingCount > 0 && <small>{pendingCount}</small>}
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
              {visible.length} 项结果 · 共 {scopedDocuments.length} 份记忆
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
                  {(doc.status === 'draft' ||
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
                      核对记忆
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
                            setMemoryEdit({
                              doc,
                              entryId: e.id,
                              content: e.content,
                              remove: true,
                            })
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
                <h2>每日记忆</h2>
                <p>在这里查看和修正从会话中整理的记忆。</p>
                <button className="secondary" onClick={() => setSection('automation')}>
                  管理记忆任务
                </button>
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
        <Modal title="核对记忆" compact onClose={() => !busy && setReviewing(undefined)}>
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
                  setNotice('记忆已核对');
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
    </section>
  );
}
