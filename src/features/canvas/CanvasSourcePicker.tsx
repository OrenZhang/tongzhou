import { t as tr } from '../../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import type { Snapshot, TongzhouAPI, FileEntry } from '../../shared/types';
import type { CanvasResource } from '../../shared/canvas';
import { Modal } from '../../components/components';
import { errorMessage } from '../../lib/feedback';

export function CanvasSourcePicker({
  api,
  data,
  sessionId,
  onSelect,
  onClose,
  imageOnly = false,
  mediaOnly,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  sessionId?: string;
  onSelect(title: string, resource: CanvasResource): void | Promise<void>;
  onClose(): void;
  imageOnly?: boolean;
  mediaOnly?: 'image' | 'video' | 'audio';
}) {
  const [importing, setImporting] = useState(false);
  const importLock = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [imported, setImported] = useState<{ title: string; resource: CanvasResource }[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const importFiles = async (paths?: string[]) => {
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setImportErrors([]);
    try {
      const value = await api.canvasImportResources({
        paths,
        media: mediaOnly ?? (imageOnly ? 'image' : undefined),
      });
      setImportErrors(value.errors);
      if (value.choices.length === 1 && !value.errors.length) {
        await onSelect(value.choices[0].title, value.choices[0].resource);
      } else if (value.choices.length) {
        setImported(value.choices);
        setKind('content');
        setQuery('');
        setRevision((value) => value + 1);
      }
    } catch (error) {
      setImportErrors([errorMessage(error)]);
    } finally {
      importLock.current = false;
      setImporting(false);
    }
  };
  const [kind, setKind] = useState<'content' | 'artifact' | 'message' | 'file'>('content'),
    [query, setQuery] = useState(''),
    [sourceSession, setSourceSession] = useState(sessionId ?? '');
  const [project, setProject] = useState(
      data.sessions.find((s) => s.id === sessionId)?.projectId ?? data.projects[0]?.id ?? '',
    ),
    [path, setPath] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<TongzhouAPI['canvasSources']>>>({
      choices: [],
      sessions: [],
    }),
    [files, setFiles] = useState<FileEntry[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const select = async (title: string, resource: CanvasResource) => {
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setError('');
    try {
      await onSelect(title, resource);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      importLock.current = false;
      setImporting(false);
    }
  };
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      void (
        kind === 'file'
          ? project
            ? api.listFiles(project, path).then((items) => {
                if (current) setFiles(items);
              })
            : Promise.resolve()
          : api
              .canvasSources({
                kind,
                query,
                sessionId: sourceSession || undefined,
                media: mediaOnly ?? (imageOnly ? 'image' : undefined),
              })
              .then((value) => {
                if (current) setResult(value);
              })
      )
        .catch((e) => {
          if (current) setError(errorMessage(e));
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, kind, query, sourceSession, project, path, imageOnly, mediaOnly, revision]);
  return (
    <Modal
      title={tr('选择画布资源')}
      subtitle={tr('选择已有资源，或导入本地文件。')}
      onClose={() => {
        if (!importLock.current) onClose();
      }}
    >
      <div
        className={'canvas-source-import' + (dragging ? ' dragging' : '')}
        aria-busy={importing}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes('Files')) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = importing ? 'none' : 'copy';
          setDragging(!importing);
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          if (importLock.current) return;
          try {
            const paths = Array.from(event.dataTransfer.files).map((file) =>
              api.droppedFilePath(file),
            );
            if (!paths.length) return;
            if (paths.some((path) => !path)) throw new Error(tr('请先将文件保存到本机后再导入。'));
            void importFiles(paths);
          } catch (error) {
            setImportErrors([errorMessage(error)]);
          }
        }}
      >
        <button className="secondary" disabled={importing} onClick={() => void importFiles()}>
          <Upload size={16} />
          {importing ? tr('正在导入…') : tr('导入本地文件')}
        </button>
        <span>{tr('也可将文件拖到这里')}</span>
        <small>{tr('文件会复制到内容库，单个文件最多 25 MB。')}</small>
      </div>
      {importErrors.length > 0 && (
        <div role="alert" className="canvas-source-import-errors">
          {importErrors.map((message, index) => (
            <p key={index}>{message}</p>
          ))}
        </div>
      )}
      <fieldset className="canvas-source-browser" disabled={importing}>
        {imported.length > 0 && (
          <div className="canvas-source-list">
            <p>{tr('已导入，选择要使用的资源')}</p>
            {imported.map((choice, index) => (
              <button key={index} onClick={() => void select(choice.title, choice.resource)}>
                {choice.title}
              </button>
            ))}
          </div>
        )}
        <div className="canvas-source-controls">
          <select
            aria-label={tr('资源来源')}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="content">{tr('内容库')}</option>
            <option value="artifact">{tr('会话作品')}</option>
            {!imageOnly && !mediaOnly && (
              <>
                <option value="message">{tr('会话消息')}</option>
                <option value="file">{tr('工作区文件')}</option>
              </>
            )}
          </select>
          {kind === 'message' && (
            <select
              aria-label={tr('来源会话')}
              value={sourceSession}
              onChange={(e) => setSourceSession(e.target.value)}
            >
              <option value="">{tr('选择会话')}</option>
              {result.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}
          {kind === 'file' ? (
            <>
              <select
                aria-label={tr('来源工作区')}
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  setPath('');
                }}
              >
                {data.projects
                  .filter((p) => !p.removed)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <button onClick={() => setPath(path.split(/[\\/]/).slice(0, -1).join('/'))}>
                {tr('上级目录')}
              </button>
              <span>{path || tr('根目录')}</span>
            </>
          ) : (
            <input
              aria-label={tr('搜索资源')}
              placeholder={tr('搜索标题或消息')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="canvas-source-list">
          {loading ? (
            <p>{tr('读取中…')}</p>
          ) : kind === 'file' ? (
            files.map((f) => (
              <button
                key={f.path}
                onClick={() =>
                  f.directory
                    ? setPath(f.path)
                    : void select(f.name, { kind: 'file', projectId: project, path: f.path })
                }
              >
                {f.directory ? '▸ ' : ''}
                {f.name}
              </button>
            ))
          ) : (
            result.choices
              .filter(
                (c) =>
                  !imported.some(
                    (item) => JSON.stringify(item.resource) === JSON.stringify(c.resource),
                  ),
              )
              .map((c, i) => (
                <button key={i} onClick={() => void select(c.title, c.resource)}>
                  {c.title}
                  <small>
                    {c.resource.kind === 'content' ? 'v' + c.resource.version : c.resource.kind}
                  </small>
                </button>
              ))
          )}
          {!loading && !error && (kind === 'file' ? !files.length : !result.choices.length) && (
            <p>{tr('暂无匹配资源')}</p>
          )}
        </div>
      </fieldset>
    </Modal>
  );
}
