import { useEffect, useId, useState } from 'react';
import { Modal } from '../../components/components';
import type { KnowledgeDocument, KnowledgeSummary } from '../../shared/knowledge';
import { knowledgeFolderPath } from '../../shared/knowledge';
import type { ContentState } from '../../shared/content';
import type { TongzhouAPI } from '../../shared/types';
import { t as tr } from '../../shared/i18n';
import './content-properties.css';

export function ContentProperties({
  api,
  document,
  onClose,
  onSaved,
}: {
  api: TongzhouAPI;
  document: KnowledgeDocument;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const id = useId();
  const [state, setState] = useState<ContentState>();
  const [folder, setFolder] = useState(document.folderId ?? '');
  const [type, setType] = useState(document.contentType ?? '');
  const [tags, setTags] = useState(document.tags.join(', '));
  const initialSources = document.sources.filter((s) => s.version).map((s) => s.id);
  const [sources, setSources] = useState(initialSources);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api
      .contentState(document.libraryId ?? 'default')
      .then((s) => {
        if (live) setState(s);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [api, document.id]);
  const items = state?.documents ?? [];
  const choices = items.filter(
    (d) =>
      d.id !== document.id &&
      !sources.includes(d.id) &&
      `${d.title} ${d.contentType ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const name = (d: KnowledgeSummary) =>
    `${d.title} · ${knowledgeFolderPath(state?.folders ?? [], d.folderId) || tr('根目录')} · ${d.id.slice(0, 8)}`;
  return (
    <Modal
      title={tr('内容属性与来源')}
      subtitle={tr('目录用于整理，类型和标签用于分类。来源保留引用版本，不复制正文。')}
      onClose={() => !busy && onClose()}
    >
      <form
        className="modal-content content-properties"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          const changed = JSON.stringify(sources) !== JSON.stringify(initialSources);
          void api
            .contentWrite({
              id: document.id,
              version: document.version,
              libraryId: document.libraryId ?? 'default',
              title: document.title,
              content: document.content,
              folderId: folder || null,
              contentType: type.trim(),
              tags: [
                ...new Set(
                  tags
                    .split(/[,，\n]/)
                    .map((t) => t.trim())
                    .filter(Boolean),
                ),
              ],
              ...(changed ? { sourceIds: sources } : {}),
            })
            .then(onSaved)
            .then(onClose)
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy || !state}>
          <label>
            {tr('目录')}
            <select
              aria-label={tr('内容目录')}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            >
              <option value="">{tr('根目录')}</option>
              {state?.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {knowledgeFolderPath(state.folders, f.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr('内容类型')}
            <input
              aria-label={tr('内容类型')}
              list={id}
              maxLength={80}
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder={tr('自定义类型，例如笔记、研究资料、提示词')}
            />
            <datalist id={id}>
              {[...new Set(items.map((d) => d.contentType).filter(Boolean))].map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </label>
          <label>
            {tr('标签（逗号分隔）')}
            <input
              aria-label={tr('标签（逗号分隔）')}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </label>
          <label>
            {tr('引用来源')}
            <input
              aria-label={tr('查找来源文档')}
              placeholder={tr('查找来源文档')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label={tr('添加来源文档')}
            value=""
            disabled={sources.length >= 20}
            onChange={(e) => {
              if (e.target.value) setSources([...sources, e.target.value]);
            }}
          >
            <option value="">{tr('选择来源文档')}</option>
            {choices.map((d) => (
              <option key={d.id} value={d.id}>
                {name(d)}
              </option>
            ))}
          </select>
          <ul className="content-source-list">
            {sources.map((source) => {
              const d = items.find((d) => d.id === source),
                saved = document.sources.find((s) => s.id === source);
              return (
                <li key={source}>
                  <span>
                    {d ? name(d) : (saved?.title ?? source)}
                    {saved?.version ? ` · v${saved.version}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSources(sources.filter((s) => s !== source))}
                  >
                    {tr('移除')}
                  </button>
                </li>
              );
            })}
          </ul>
          <small>
            {tr(
              '仅修改目录、类型或标签不会刷新已有来源版本。修改来源列表会采用所选文档的当前版本。',
            )}
          </small>
        </fieldset>
        {error && (
          <p role="alert" className="danger">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !state} type="submit">
          {busy ? tr('保存中…') : tr('保存')}
        </button>
      </form>
    </Modal>
  );
}
