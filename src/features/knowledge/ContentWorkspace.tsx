import { WorkspaceToolbar } from '../workspace/WorkspaceToolbar';
import { useEffect, useRef, useState } from 'react';
import { FileText, MessageSquare, Plus, Upload, History } from 'lucide-react';
import type { Snapshot, TongzhouAPI } from '../../shared/types';
import type { ContentState } from '../../shared/content';
import { KnowledgeFolders } from './KnowledgeFolders';
import { ContentDocument } from './ContentDocument';
import './content.css';

export function ContentWorkspace({
  api,
  data,
  initialDocument,
  onInspect,
  onSources,
  onArtifact,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  initialDocument?: { id: string; libraryId: string };
  onInspect(id: string): void;
  onSources(): void;
  onArtifact?(id: string): void;
}) {
  const [library] = useState(initialDocument?.libraryId ?? 'default');
  const libraryRef = useRef(library);
  const [folder, setFolder] = useState('*');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<ContentState>();
  const [documentId, setDocumentId] = useState(initialDocument?.id ?? '');
  const [chat, setChat] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const refresh = async () => {
    const id = ++request.current;
    const target = libraryRef.current;
    const result = await api.contentState(target, query);
    if (id === request.current && target === libraryRef.current) setState(result);
  };
  useEffect(() => {
    let timer = setTimeout(() => void refresh().catch((e) => setError(String(e))), 100);
    const off = api.onEvent((e) => {
      if (e.type === 'changed') {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh().catch((e) => setError(String(e))), 250);
      }
    });
    return () => {
      ++request.current;
      clearTimeout(timer);
      off();
    };
  }, [library, query]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const createDocument = async () => {
    const doc = await api.contentWrite({
      libraryId: library,
      folderId: folder === '*' ? null : folder || null,
      title: '未命名文档',
      content: '',
    });
    setDocumentId(doc.id);
  };
  return (
    <div className="content-workspace">
      <WorkspaceToolbar className="content-toolbar">
        <button
          className="icon-button"
          aria-label="查看来源记录"
          title="查看文档来源与版本记录"
          onClick={onSources}
        >
          <History size={16} />
        </button>
        <button
          className="icon-button"
          title={chat ? '收起文档对话' : '打开文档对话'}
          aria-label="切换文档对话"
          aria-pressed={chat}
          aria-expanded={chat}
          aria-controls="content-document-chat"
          onClick={() => {
            setChat(!chat);
            if (!chat && window.innerWidth <= 1150)
              requestAnimationFrame(() =>
                document
                  .getElementById('content-document-chat')
                  ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
              );
          }}
        >
          <MessageSquare size={17} />
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const result = await api.contentImport(
                library,
                folder === '*' || !folder ? undefined : folder,
              );
              if (result.imported[0]) setDocumentId(result.imported[0].id);
              if (result.errors.length) setError(result.errors.join('；'));
            })
          }
        >
          <Upload size={14} />
          导入
        </button>
        <button className="primary" disabled={busy} onClick={() => void action(createDocument)}>
          <Plus size={14} />
          新建文档
        </button>
      </WorkspaceToolbar>
      {error && (
        <p role="alert" className="danger">
          {error}
        </p>
      )}
      <div className={`content-layout ${chat ? 'with-chat' : ''}`}>
        <aside className="content-tree">
          <input
            aria-label="搜索内容库"
            placeholder="搜索标题或正文"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <KnowledgeFolders
            api={api}
            folders={state?.folders ?? []}
            libraryId={library}
            selected={folder}
            onSelect={setFolder}
            onChanged={refresh}
          />
          <div className="content-document-list">
            {state?.documents
              .filter((d) => folder === '*' || (d.folderId ?? '') === folder)
              .map((d) => (
                <button
                  key={d.id}
                  className={documentId === d.id ? 'selected' : ''}
                  onClick={() => setDocumentId(d.id)}
                >
                  <FileText size={14} />
                  <span>
                    {d.title}
                    <small>
                      {d.origin === 'import' ? '原件' : d.contentType || '文档'} · v{d.version}
                    </small>
                  </span>
                </button>
              ))}
            {!state?.documents.length && (
              <p className="muted">新建文档或导入资料，开始维护你的内容。</p>
            )}
          </div>
        </aside>
        {documentId ? (
          <ContentDocument
            key={documentId}
            api={api}
            data={data}
            documentId={documentId}
            folders={state?.folders ?? []}
            showChat={chat}
            onChange={refresh}
            onOpen={setDocumentId}
            onInspect={() => onInspect(documentId)}
            onArtifact={onArtifact}
            onDelete={() => {
              setDocumentId('');
              void refresh();
            }}
          />
        ) : (
          <div className="content-empty">
            <FileText size={32} />
            <h2>内容由你定义</h2>
            <p>管理资料、编辑文档，或让 AI 围绕选中的内容协作。</p>
          </div>
        )}
        {!documentId && chat && (
          <aside id="content-document-chat" className="content-chat" aria-label="文档对话">
            <header>
              <strong>文档对话</strong>
              <small>尚未选择文档</small>
            </header>
            <div className="content-chat-messages">
              <p>从左侧选择一篇文档，即可围绕正文提问、润色或拆分内容。</p>
              <p className="muted">还没有文档？可以新建文档，或从顶部导入资料。</p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void action(createDocument)}
              >
                新建文档并打开对话
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
