import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import type { WorkspaceLayout } from '../workspace/workspace-state';
import artifactPrompts from '../../../prompts/artifacts.json';
import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Image as ImageIcon, ArrowUpRight } from 'lucide-react';
import { Field } from '../../components/components';
import {
  artifactKinds,
  artifactDay,
  artifactDateRange,
  type Artifact,
  type ArtifactKind,
  type ArtifactPage,
  type ArtifactPreview,
} from '../../shared/artifacts';
import type { Snapshot, TongzhouAPI } from '../../shared/types';
import type { ContentState } from '../../shared/content';
import { knowledgeFolderPath } from '../../shared/knowledge';
import './artifacts.css';
import { FileLink } from '../../components/files/FileLink';
import { HtmlPreview } from '../../components/markdown/HtmlPreview';

const sizeLabel = (size?: number) =>
  size === undefined
    ? '外部链接'
    : size < 1024 * 1024
      ? `${Math.ceil(size / 1024)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
function ArtworkCard({ item, onOpen }: { item: Artifact; onOpen(): void }) {
  return (
    <FileLink
      className="artifact-card"
      onOpen={onOpen}
      name={item.name}
      label={`查看作品 ${item.name}`}
      title={`${item.name} · ${artifactKinds[item.kind]} · ${sizeLabel(item.size)}`}
      icon={item.kind === 'image' ? <ImageIcon size={15} /> : undefined}
    />
  );
}
export function ArtifactCards({ ids, onOpen }: { ids: string[]; onOpen(id: string): void }) {
  const [items, setItems] = useState<Artifact[]>([]);
  const key = [...new Set(ids)].join(',');
  useEffect(() => {
    let live = true;
    void Promise.all(
      key
        .split(',')
        .filter(Boolean)
        .map((id) => window.tongzhou.artifactRead(id).catch(() => null)),
    ).then((all) => {
      if (live) setItems(all.filter((a): a is Artifact => !!a));
    });
    const off = window.tongzhou.onEvent((e) => {
      if (e.type === 'changed')
        void Promise.all(
          key
            .split(',')
            .filter(Boolean)
            .map((id) => window.tongzhou.artifactRead(id).catch(() => null)),
        ).then((all) => {
          if (live) setItems(all.filter((a): a is Artifact => !!a));
        });
    });
    return () => {
      live = false;
      off();
    };
  }, [key]);
  return items.length ? (
    <div className="artifact-strip" aria-label="本轮生成的作品">
      {items.map((a) => (
        <ArtworkCard key={a.id} item={a} onOpen={() => onOpen(a.id)} />
      ))}
    </div>
  ) : null;
}
export function ArtifactsCenter({
  api,
  data,
  sessionId,
  onOpen,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  sessionId?: string;
  onOpen(id: string, organize?: boolean): void;
}) {
  const [day, setDay] = useState('');
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState<ArtifactKind | ''>(''),
    [project, setProject] = useState(''),
    [session, setSession] = useState(sessionId ?? '');
  const [page, setPage] = useState<ArtifactPage>({ items: [], total: 0, nextOffset: null }),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => setSession(sessionId ?? ''), [sessionId]);
  const load = async (offset = 0) => {
    const token = ++request.current;
    setLoading(true);
    setError('');
    try {
      const result = await api.artifactList({
        query,
        ...artifactDateRange(day),
        kind: kind || undefined,
        projectId: project || undefined,
        sessionId: session || undefined,
        offset,
      });
      if (token !== request.current) return;
      setPage((old) => ({
        ...result,
        items: offset ? [...old.items, ...result.items] : result.items,
      }));
    } catch (e) {
      if (token === request.current) setError(String(e));
    } finally {
      if (token === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    let live = true;
    ++request.current;
    const timer = setTimeout(() => {
      setLoading(true);
      void api
        .artifactList({
          query,
          ...artifactDateRange(day),
          kind: kind || undefined,
          projectId: project || undefined,
          sessionId: session || undefined,
        })
        .then((p) => {
          if (live) {
            setPage(p);
            setError('');
          }
        })
        .catch((e) => {
          if (live) setError(String(e));
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, kind, project, session, day, data]);
  const groups = new Map<string, Artifact[]>();
  for (const a of page.items) {
    const date = artifactDay(a.createdAt);
    groups.set(date, [...(groups.get(date) ?? []), a]);
  }
  return (
    <div className="artifacts-page">
      <div className="artifact-filters">
        <input
          aria-label="搜索作品"
          placeholder="搜索作品名称…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="作品类型"
          value={kind}
          onChange={(e) => setKind(e.target.value as ArtifactKind | '')}
        >
          <option value="">全部类型</option>
          {Object.entries(artifactKinds).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="作品项目" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">全部项目</option>
          {data.projects
            .filter((p) => !p.removed && !p.sourceProjectId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <select
          aria-label="作品来源会话"
          value={session}
          onChange={(e) => setSession(e.target.value)}
        >
          <option value="">全部会话</option>
          {data.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="作品日期"
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
        {day && (
          <button className="text-button" onClick={() => setDay('')}>
            全部日期
          </button>
        )}
        <small>{page.total} 件</small>
      </div>
      {error && (
        <p role="alert" className="danger">
          {error}
        </p>
      )}
      {[...groups].map(([date, items]) => (
        <section className="artifact-day" key={date} aria-label={date}>
          <header>
            <h2>{date}</h2>
            <small>{items.length} 件</small>
          </header>
          <div className="artifact-grid">
            {items.map((a) => (
              <div className="artifact-entry" key={a.id}>
                <ArtworkCard item={a} onOpen={() => onOpen(a.id)} />
                <button className="text-button artifact-process" onClick={() => onOpen(a.id, true)}>
                  整理
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
      {!loading && !page.items.length && (
        <div className="artifact-empty">
          <ImageIcon size={32} />
          <h2>{query || kind || project || session || day ? '没有匹配的作品' : '还没有作品'}</h2>
          <p>让 AI 生成图片或交付文件后，成果会显示在聊天和这里。</p>
        </div>
      )}
      {loading && <p role="status">正在加载作品…</p>}
      {page.nextOffset !== null && (
        <button disabled={loading} onClick={() => void load(page.nextOffset!)}>
          加载更多作品
        </button>
      )}
    </div>
  );
}
export function ArtifactDetail({
  layout,
  updateLayout,
  id,
  api,
  data,
  onClose,
  onSource,
  onContinue,
  onKnowledge,
  onDeleted,
  initialOrganizing = false,
}: {
  id: string;
  api: TongzhouAPI;
  data: Snapshot;
  onClose(): void;
  onSource(sessionId: string): void;
  onContinue(item: Artifact, instruction?: string): void;
  onKnowledge(id: string, libraryId: string): void;
  onDeleted(): void;
  initialOrganizing?: boolean;
  layout: WorkspaceLayout;
  updateLayout(patch: Partial<WorkspaceLayout>): void;
}) {
  const [item, setItem] = useState<Artifact>(),
    [preview, setPreview] = useState<ArtifactPreview>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false),
    [saving, setSaving] = useState(false);
  const [createFolder, setCreateFolder] = useState(false),
    [newFolderName, setNewFolderName] = useState('');
  const [organizing, setOrganizing] = useState(initialOrganizing),
    [instruction, setInstruction] = useState('');
  const [library, setLibrary] = useState('default'),
    [folder, setFolder] = useState(''),
    [contents, setContents] = useState<ContentState>();
  useEffect(() => {
    let live = true;
    void api
      .artifactRead(id)
      .then((a) => {
        if (live) {
          setItem(a);
        }
        return api.artifactPreview(id);
      })
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    if (!saving) return;
    let live = true;
    setContents(undefined);
    void api
      .contentState(library)
      .then((s) => {
        if (live) {
          setContents(s);
          setFolder((old) => (s.folders.some((f) => f.id === old) ? old : ''));
        }
      })
      .catch((e) => {
        if (live) {
          setError(String(e));
          if (library !== 'default') setLibrary('default');
        }
      });
    return () => {
      live = false;
    };
  }, [library, saving]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const source = item && data.sessions.find((s) => s.id === item.sessionId);
  return (
    <WorkspaceFrame
      className="artifact-workspace"
      label="文件工作区"
      width={layout.width}
      expanded={layout.expanded}
      onResize={(width) => updateLayout({ width, expanded: false })}
      onExpand={() => updateLayout({ expanded: !layout.expanded })}
      onClose={onClose}
      header={
        <strong className="workspace-file-title" title={item?.name}>
          {item?.name ?? '文件预览'}
        </strong>
      }
    >
      <div className="artifact-detail">
        {error && (
          <p className="danger" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {item && (
          <>
            <div className="artifact-preview">
              {preview?.type === 'image' ? (
                <img src={preview.content} alt={item.name} />
              ) : preview?.type === 'text' ? (
                item.mimeType === 'text/html' || /\.html?$/i.test(item.name) ? (
                  <HtmlPreview text={preview.content ?? ''} />
                ) : (
                  <pre>{preview.content}</pre>
                )
              ) : (
                <div className="artifact-empty">
                  <FileText size={38} />
                  <p>
                    {preview?.type === 'external'
                      ? '此作品保留的是外部链接，可打开原链接查看。'
                      : '使用本地应用打开，或下载文件查看。'}
                  </p>
                </div>
              )}
            </div>
            <div className="artifact-meta">
              <span>
                {artifactKinds[item.kind]} · {sizeLabel(item.size)}
              </span>
              <span>{new Date(item.createdAt).toLocaleString()}</span>
              <span title={item.model}>{item.model}</span>
            </div>
            <div className="artifact-source">
              <span>
                来源：{source?.title ?? '原会话已删除'}
                {source?.archived ? '（已归档）' : ''}
              </span>
              {source && (
                <button className="text-button" onClick={() => onSource(source.id)}>
                  回到会话 <ArrowUpRight size={13} />
                </button>
              )}
            </div>
            <div className="row artifact-actions">
              <button disabled={busy} onClick={() => void action(() => api.artifactOpen(id))}>
                {item.remoteUrl ? '打开链接' : '打开文件'}
              </button>
              {!item.remoteUrl && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      if (await api.artifactExport(id)) setNotice('作品已下载');
                    })
                  }
                >
                  <Download size={14} />
                  下载
                </button>
              )}
              <button
                className="primary"
                disabled={!source || source.archived}
                onClick={() => onContinue(item)}
              >
                继续处理
              </button>
              <button
                disabled={!source || source.archived}
                onClick={() => setOrganizing(!organizing)}
              >
                整理内容
              </button>
              {!item.remoteUrl && <button onClick={() => setSaving(!saving)}>保存到内容库</button>}
              <button className="text-button danger" onClick={() => setDeleting(true)}>
                删除作品
              </button>
            </div>
            {organizing && (
              <div className="artifact-organize">
                <button
                  className="text-button"
                  onClick={() => setInstruction(artifactPrompts.organize)}
                >
                  使用整理提示词
                </button>
                <Field label="整理要求">
                  <textarea
                    aria-label="整理要求"
                    rows={3}
                    placeholder="描述希望如何处理作品，也可以结合当前会话历史…"
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                  />
                </Field>
                <button
                  className="primary"
                  disabled={!instruction.trim()}
                  onClick={() => onContinue(item, instruction.trim())}
                >
                  前往会话整理
                </button>
              </div>
            )}
            {saving && (
              <div className="artifact-save">
                <Field label="内容库">
                  <select
                    aria-label="保存到内容库"
                    value={library}
                    onChange={(e) => setLibrary(e.target.value)}
                  >
                    {contents?.libraries.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={createFolder ? '上级目录' : '目录'}>
                  <select
                    aria-label="作品保存目录"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                  >
                    <option value="">{createFolder ? '顶层目录' : '未分类'}</option>
                    {contents?.folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {knowledgeFolderPath(contents.folders, f.id)}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="artifact-folder-toggle">
                  <input
                    type="checkbox"
                    checked={createFolder}
                    onChange={(e) => setCreateFolder(e.target.checked)}
                  />
                  新建目录
                </label>
                {createFolder && (
                  <Field label="新目录名称">
                    <input
                      aria-label="新目录名称"
                      value={newFolderName}
                      maxLength={100}
                      onChange={(e) => setNewFolderName(e.target.value)}
                    />
                  </Field>
                )}
                <button
                  className="primary"
                  disabled={busy || !contents || (createFolder && !newFolderName.trim())}
                  onClick={() =>
                    void action(async () => {
                      const documentId = await api.artifactToKnowledge(
                        id,
                        library,
                        folder || undefined,
                        createFolder ? newFolderName.trim() : undefined,
                      );
                      onKnowledge(documentId, library);
                    })
                  }
                >
                  保存到内容库
                </button>
              </div>
            )}
            {deleting && (
              <div className="artifact-delete" role="alert">
                <p>删除作品副本？原始项目文件和聊天记录会保留。</p>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api.artifactDelete(id);
                      onDeleted();
                    })
                  }
                >
                  确认删除作品
                </button>
                <button onClick={() => setDeleting(false)}>取消</button>
              </div>
            )}
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
