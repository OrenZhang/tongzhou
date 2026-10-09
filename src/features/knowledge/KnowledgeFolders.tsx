import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FileText,
  FolderPlus,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { ChoicePicker } from '../../components/controls/ChoicePicker';
import { Field, Modal } from '../../components/components';
import type { TongzhouAPI } from '../../shared/types';
import {
  knowledgeFolderBranch,
  knowledgeFolderPath,
  type KnowledgeSummary,
  type KnowledgeFolder,
  type KnowledgeFolderInput,
} from '../../shared/knowledge';

export function wikiFolderOptions(folders: KnowledgeFolder[], rootLabel = '未分类') {
  return [
    { value: '', label: rootLabel },
    ...folders
      .map((folder) => ({ value: folder.id, label: knowledgeFolderPath(folders, folder.id) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
  ];
}

export function KnowledgeFolders({
  api,
  folders,
  selected,
  onSelect,
  onChanged,
  libraryId,
  documents,
  selectedDocument,
  onOpenDocument,
  searching = false,
}: {
  api: TongzhouAPI;
  folders: KnowledgeFolder[];
  selected: string;
  onSelect(id: string): void;
  onChanged(): Promise<void>;
  libraryId?: string;
  documents?: KnowledgeSummary[];
  selectedDocument?: string;
  onOpenDocument?(id: string): void;
  searching?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<KnowledgeFolderInput>();
  const [deleting, setDeleting] = useState<KnowledgeFolder>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const begin = (value: KnowledgeFolderInput) => {
    setError('');
    setEditing(value);
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await onChanged();
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
  const branch = editing?.id ? knowledgeFolderBranch(folders, editing.id) : new Set<string>();
  const activeFolder = documents?.find((d) => d.id === selectedDocument)?.folderId;
  const ancestorIds = (folderId?: string) => {
    const result = new Set<string>();
    while (folderId && !result.has(folderId)) {
      result.add(folderId);
      folderId = folders.find((f) => f.id === folderId)?.parentId;
    }
    return result;
  };
  const revealPath = [...ancestorIds(activeFolder)].join(',');
  useEffect(() => {
    setCollapsed(
      (previous) => new Set([...previous].filter((id) => !revealPath.split(',').includes(id))),
    );
  }, [selectedDocument, revealPath]);
  const matches = new Set(documents?.flatMap((d) => [...ancestorIds(d.folderId)]));
  const fileRows = (folderId: string | undefined, depth: number) =>
    documents
      ?.filter((d) => (d.folderId || undefined) === folderId)
      .sort((a, b) =>
        a.derivation && b.derivation && a.derivation.batchId === b.derivation.batchId
          ? a.derivation.index - b.derivation.index
          : a.title.localeCompare(b.title, 'zh-CN', { numeric: true }),
      )
      .map((d) => (
        <button
          key={d.id}
          className="content-file-row"
          data-document-id={d.id}
          aria-current={selectedDocument === d.id ? 'page' : undefined}
          title={d.title}
          style={{ paddingLeft: 20 + depth * 12 }}
          onClick={() => {
            onSelect(d.folderId ?? '');
            onOpenDocument?.(d.id);
          }}
        >
          <FileText size={14} />
          <span>{d.title}</span>
        </button>
      ));
  const tree = (parentId?: string, depth = 0): React.ReactNode =>
    folders
      .filter((f) => f.parentId === parentId && (!searching || matches.has(f.id)))
      .map((folder) => {
        const children = !!documents || folders.some((f) => f.parentId === folder.id);
        const closed = !searching && collapsed.has(folder.id);
        return (
          <div key={folder.id} data-folder-id={folder.id}>
            <div
              className="wiki-folder-row"
              data-selected={selected === folder.id && !selectedDocument}
              style={{ paddingLeft: depth * 12 }}
            >
              {children ? (
                <button
                  className="icon-button wiki-folder-toggle"
                  aria-label={`${closed ? '展开' : '折叠'}目录 ${folder.name}`}
                  aria-expanded={!closed}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (closed) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })
                  }
                >
                  {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              ) : (
                <span className="wiki-folder-spacer" />
              )}
              <button
                className="wiki-folder-name"
                aria-pressed={selected === folder.id}
                title={knowledgeFolderPath(folders, folder.id)}
                onClick={() => {
                  onSelect(folder.id);
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    next.delete(folder.id);
                    return next;
                  });
                }}
              >
                <Folder size={14} />
                <span>{folder.name}</span>
              </button>
              <button
                className="icon-button wiki-folder-manage"
                aria-label={`管理目录 ${folder.name}`}
                title="重命名、移动或删除目录"
                onClick={() => begin({ ...folder, parentId: folder.parentId ?? null })}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
            {children && !closed && (
              <div className="wiki-folder-children">
                {tree(folder.id, depth + 1)}
                {fileRows(folder.id, depth + 1)}
              </div>
            )}
          </div>
        );
      });
  return (
    <>
      <nav className="wiki-folders" aria-label="文档目录">
        <div className="wiki-folder-heading">
          <strong>文档目录</strong>
          <button
            className="icon-button"
            aria-label="新建目录"
            title="新建目录"
            onClick={() =>
              begin({ name: '', parentId: selected && selected !== '*' ? selected : null })
            }
          >
            <FolderPlus size={15} />
          </button>
        </div>
        {!documents && (
          <>
            <button
              className="wiki-folder-root"
              aria-pressed={selected === '*'}
              onClick={() => onSelect('*')}
            >
              全部文档
            </button>
            <button
              className="wiki-folder-root"
              aria-pressed={selected === ''}
              onClick={() => onSelect('')}
            >
              未分类
            </button>
          </>
        )}
        <div className="wiki-folder-tree">
          {tree()}
          {fileRows(undefined, 0)}
        </div>
        {documents && !documents.length && (
          <p className="muted">{searching ? '没有匹配的文档' : '暂无文档'}</p>
        )}
        {error && !editing && !deleting && (
          <p className="danger" role="alert">
            {error}
          </p>
        )}
        {!documents && !folders.length && (
          <p className="muted">按项目或主题新建目录，逐步整理知识页。</p>
        )}
      </nav>
      {editing && (
        <Modal
          title={editing.id ? '管理文档目录' : '新建文档目录'}
          compact
          onClose={() => !busy && setEditing(undefined)}
        >
          <div className="modal-content wiki-folder-editor">
            <Field label="目录名称">
              <input
                autoFocus
                aria-label="目录名称"
                maxLength={60}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="上级目录">
              <ChoicePicker
                label="上级目录"
                value={editing.parentId ?? ''}
                searchable
                options={wikiFolderOptions(
                  folders.filter((f) => !branch.has(f.id)),
                  '顶层目录',
                )}
                onChange={(parentId) => setEditing({ ...editing, parentId: parentId || null })}
              />
            </Field>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            {editing.id && (
              <button
                className="text-button danger"
                disabled={busy}
                onClick={() => {
                  setDeleting(folders.find((f) => f.id === editing.id));
                  setEditing(undefined);
                  setError('');
                }}
              >
                <Trash2 size={14} />
                删除目录
              </button>
            )}
            <button className="secondary" disabled={busy} onClick={() => setEditing(undefined)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !editing.name.trim()}
              onClick={() =>
                void perform(async () => {
                  const folder = await api.knowledgeFolderSave({
                    ...editing,
                    ...(libraryId ? { libraryId } : {}),
                  });
                  setEditing(undefined);
                  setCollapsed(new Set());
                  onSelect(folder.id);
                })
              }
            >
              {busy ? '保存中…' : '保存目录'}
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="删除文档目录" compact onClose={() => !busy && setDeleting(undefined)}>
          <div className="modal-content confirmation-content">
            <p>
              删除“<strong>{deleting.name}</strong>”及其子目录？
            </p>
            <p className="muted">
              目录中的 文档 页面全部保留，并移到“未分类”。原文、来源引用和历史版本不受影响。
            </p>
            {error && (
              <p role="alert" className="error">
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
                void perform(async () => {
                  await api.knowledgeFolderDelete(deleting.id, deleting.version);
                  if (knowledgeFolderBranch(folders, deleting.id).has(selected)) onSelect('');
                  setDeleting(undefined);
                })
              }
            >
              {busy ? '删除中…' : '确认删除目录'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
