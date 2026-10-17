import { useEffect, useState } from 'react';
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
}: {
  api: TongzhouAPI;
  data: Snapshot;
  sessionId?: string;
  onSelect(title: string, resource: CanvasResource): void;
  onClose(): void;
  imageOnly?: boolean;
}) {
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
                media: imageOnly ? 'image' : undefined,
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
  }, [api, kind, query, sourceSession, project, path]);
  return (
    <Modal title="选择画布资源" subtitle="引用已有内容；原件仍由来源模块管理。" onClose={onClose}>
      <div className="canvas-source-controls">
        <select
          aria-label="资源来源"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="content">内容库</option>
          <option value="artifact">会话作品</option>
          {!imageOnly && (
            <>
              <option value="message">会话消息</option>
              <option value="file">工作区文件</option>
            </>
          )}
        </select>
        {kind === 'message' && (
          <select
            aria-label="来源会话"
            value={sourceSession}
            onChange={(e) => setSourceSession(e.target.value)}
          >
            <option value="">选择会话</option>
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
              aria-label="来源工作区"
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
              上级目录
            </button>
            <span>{path || '根目录'}</span>
          </>
        ) : (
          <input
            aria-label="搜索资源"
            placeholder="搜索标题或消息"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="canvas-source-list">
        {loading ? (
          <p>读取中…</p>
        ) : kind === 'file' ? (
          files.map((f) => (
            <button
              key={f.path}
              onClick={() =>
                f.directory
                  ? setPath(f.path)
                  : onSelect(f.name, { kind: 'file', projectId: project, path: f.path })
              }
            >
              {f.directory ? '▸ ' : ''}
              {f.name}
            </button>
          ))
        ) : (
          result.choices.map((c, i) => (
            <button key={i} onClick={() => onSelect(c.title, c.resource)}>
              {c.title}
              <small>
                {c.resource.kind === 'content' ? 'v' + c.resource.version : c.resource.kind}
              </small>
            </button>
          ))
        )}
        {!loading && !error && (kind === 'file' ? !files.length : !result.choices.length) && (
          <p>暂无匹配资源</p>
        )}
      </div>
    </Modal>
  );
}
