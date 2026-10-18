import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, PenTool, Pencil, Trash2 } from 'lucide-react';
import type { CanvasState } from '../../shared/canvas';
import type { TongzhouAPI } from '../../shared/types';
import { getLocale, t as tr } from '../../shared/i18n';
import { Modal } from '../../components/components';
import { errorMessage } from '../../lib/feedback';

type StudioItem = CanvasState['canvases'][number];

export function StudioLibrary({ api, onOpen }: { api: TongzhouAPI; onOpen(id?: string): void }) {
  const [items, setItems] = useState<StudioItem[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<StudioItem>();
  const [deleting, setDeleting] = useState<StudioItem>();
  const [title, setTitle] = useState('');
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    try {
      const state = await api.canvasState();
      if (token === request.current) setItems(state.canvases);
    } catch (e) {
      if (token === request.current) setError(errorMessage(e));
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    const off = api.onEvent((event) => {
      if (event.type === 'changed') void refresh();
    });
    return () => {
      off();
      request.current++;
    };
  }, [api, refresh]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  const visible = items.filter(
    (item) =>
      (!mode || (item.mode ?? 'workflow') === mode) &&
      item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div className="studio-library" aria-busy={loading || busy}>
      <p className="studio-library-hint">
        {tr('已保存的画布和白板会自动显示在这里，打开即可继续编辑。')}
      </p>
      <div className="artifact-filters">
        <input
          aria-label={tr('搜索创作')}
          placeholder={tr('搜索画布或白板名称…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select aria-label={tr('创作类型')} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">{tr('全部类型')}</option>
          <option value="workflow">{tr('工作流画布')}</option>
          <option value="whiteboard">{tr('白板')}</option>
        </select>
        <button onClick={() => onOpen()}>{tr('开始创作')}</button>
      </div>
      {error && !editing && !deleting && (
        <p role="alert" className="danger">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">{tr('加载中…')}</p>
      ) : !visible.length ? (
        <div className="artifact-empty">
          <h2>{query || mode ? tr('没有匹配的创作') : tr('还没有保存的创作')}</h2>
          <p>{tr('在「创作」中新建工作流画布或白板后，即可在这里管理。')}</p>
        </div>
      ) : (
        <div className="studio-library-list" role="list">
          {visible.map((item) => {
            const whiteboard = item.mode === 'whiteboard';
            const Icon = whiteboard ? PenTool : GitBranch;
            return (
              <article
                className="studio-library-item"
                role="listitem"
                key={item.id}
                data-canvas-id={item.id}
              >
                <button
                  className="studio-library-open"
                  onClick={() => onOpen(item.id)}
                  aria-label={tr('打开 {0}', [item.title])}
                  title={item.title}
                >
                  <Icon size={17} />
                  <span>
                    <strong>{item.title}</strong>
                    <small
                      title={tr('更新于 {0}', [
                        new Date(item.updatedAt).toLocaleString(getLocale()),
                      ])}
                    >
                      {whiteboard ? tr('白板') : tr('工作流画布')} ·{' '}
                      {new Date(item.updatedAt).toLocaleDateString(getLocale())}
                    </small>
                  </span>
                </button>
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label={tr('重命名 {0}', [item.title])}
                  title={tr('重命名')}
                  onClick={() => {
                    setError('');
                    setEditing(item);
                    setTitle(item.title);
                  }}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label={tr('删除 {0}', [item.title])}
                  title={tr('删除')}
                  onClick={() => {
                    setError('');
                    setDeleting(item);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </article>
            );
          })}
        </div>
      )}
      {editing && (
        <Modal
          title={tr('重命名创作')}
          onClose={() => {
            if (!busy) setEditing(undefined);
          }}
        >
          <form
            className="studio-library-form"
            onSubmit={(event) => {
              event.preventDefault();
              void action(async () => {
                const { canvas } = await api.canvasState(editing.id);
                if (!canvas) throw new Error(tr('创作已不存在，请刷新列表。'));
                const { updatedAt, ...input } = canvas;
                const next = await api.canvasSave({
                  ...input,
                  version: editing.version,
                  title: title.trim(),
                });
                // Renaming must not invalidate a locally saved, unfinished editing draft.
                try {
                  const key = 'tongzhou.canvas.draft.' + editing.id;
                  const draft = JSON.parse(localStorage.getItem(key) ?? 'null');
                  if (draft?.id === editing.id && draft.version === editing.version)
                    localStorage.setItem(
                      key,
                      JSON.stringify({ ...draft, title: next.title, version: next.version }),
                    );
                } catch {}
                setEditing(undefined);
              });
            }}
          >
            <label>
              {tr('名称')}
              <input
                autoFocus
                required
                maxLength={180}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="danger">
                {error}
              </p>
            )}
            <div className="studio-library-actions">
              <button type="button" disabled={busy} onClick={() => setEditing(undefined)}>
                {tr('取消')}
              </button>
              <button className="primary" disabled={busy || !title.trim()}>
                {tr('保存')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={tr('删除创作')}
          onClose={() => {
            if (!busy) setDeleting(undefined);
          }}
        >
          <div className="studio-library-form">
            <p>
              {tr('删除「{0}」？此操作无法撤销，生成的作品和执行记录会保留。', [deleting.title])}
            </p>
            {error && (
              <p role="alert" className="danger">
                {error}
              </p>
            )}
            <div className="studio-library-actions">
              <button disabled={busy} onClick={() => setDeleting(undefined)}>
                {tr('取消')}
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api.canvasDelete(deleting.id, deleting.version);
                    try {
                      localStorage.removeItem('tongzhou.canvas.draft.' + deleting.id);
                    } catch {}
                    setDeleting(undefined);
                  })
                }
              >
                {tr('删除')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
