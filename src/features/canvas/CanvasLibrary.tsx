import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/components';
import type { TongzhouAPI } from '../../shared/types';
import {
  canvasPrompts,
  fillPrompt,
  promptVariables,
  type CanvasPrompt,
} from '../../shared/canvas-prompts';
import { errorMessage } from '../../lib/feedback';

type Prompt = CanvasPrompt & {
  version?: number;
  libraryId?: string;
  folderId?: string;
};
export function CanvasLibrary({
  api,
  mode,
  initialText,
  onClose,
  onPrompt,
  onTemplate,
}: {
  api: TongzhouAPI;
  mode: 'prompt' | 'template';
  initialText?: string;
  onClose(): void;
  onPrompt(text: string, title: string, replace: boolean): void;
  onTemplate(documentId: string, version: number): Promise<void>;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Prompt[]>([]),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [selected, setSelected] = useState<Prompt>(),
    [values, setValues] = useState<Record<string, string>>({}),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(''),
    [content, setContent] = useState(initialText ?? ''),
    [tags, setTags] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = async () => setItems(await api.canvasLibrary(mode));
  useEffect(() => {
    if (!editing) search.current?.focus();
  }, [editing]);
  useEffect(() => {
    void refresh().catch((e) => setError(errorMessage(e)));
  }, [api, mode]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const choose = (p: Prompt) => {
    setSelected(p);
    setValues({});
    setEditing(false);
    setError('');
  };
  const insert = (replace: boolean) => {
    try {
      onPrompt(fillPrompt(selected!.content, values), selected!.title, replace);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const catalog: Prompt[] = [...(mode === 'prompt' ? canvasPrompts : []), ...items];
  const categoryOf = (p: Prompt) => p.category ?? (p.version ? '自定义' : '同舟内置');
  const visible = catalog.filter(
    (p) =>
      (!category || categoryOf(p) === category) &&
      `${p.title} ${p.tags.join(' ')} ${categoryOf(p)}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <Modal title={mode === 'prompt' ? '提示词库' : '工作流模板'} onClose={onClose} wide>
      <div className="canvas-library">
        <aside>
          <input
            ref={search}
            aria-label="搜索名称或标签"
            placeholder="搜索名称或标签"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {mode === 'prompt' && (
            <label>
              分类
              <select
                aria-label="提示词分类"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">全部分类</option>
                {[...new Set(catalog.map(categoryOf))].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          {mode === 'prompt' && (
            <button
              onClick={() => {
                setSelected(undefined);
                setTitle('');
                setContent(initialText ?? '');
                setTags('');
                setEditing(true);
              }}
            >
              新建提示词
            </button>
          )}
          <small role="status">共 {visible.length} 条</small>
          {visible.map((p) => (
            <button key={p.id} aria-pressed={selected?.id === p.id} onClick={() => choose(p)}>
              <strong>{p.title}</strong>
              {mode === 'prompt' && <small>{categoryOf(p)}</small>}
              <small>{p.tags.join(' · ') || (mode === 'template' ? '工作流模板' : '自定义')}</small>
            </button>
          ))}
        </aside>
        <div className="canvas-library-detail">
          {editing ? (
            <>
              <label>
                名称
                <input value={title} maxLength={180} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label>
                标签（逗号分隔）
                <input value={tags} onChange={(e) => setTags(e.target.value)} />
              </label>
              <label>
                提示词
                <textarea
                  aria-label="提示词"
                  rows={10}
                  value={content}
                  maxLength={32000}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="使用 {{变量名}} 定义填写项"
                />
              </label>
              <button
                disabled={busy || !title.trim() || !content.trim()}
                onClick={() =>
                  void perform(async () => {
                    await api.canvasSavePrompt({
                      id: selected?.version ? selected.id : undefined,
                      version: selected?.version,
                      title,
                      content,
                      tags: tags
                        .split(/[,，]/)
                        .map((t) => t.trim())
                        .filter(Boolean),
                    });
                    await refresh();
                    setEditing(false);
                    setSelected(undefined);
                  })
                }
              >
                保存到内容库
              </button>
            </>
          ) : selected ? (
            <>
              <h3>{selected.title}</h3>
              {mode === 'template' ? (
                <>
                  <p>
                    恢复节点、连线、分组和提示词。使用前重新选择素材与插件连接，执行不会自动启动。
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await onTemplate(selected.id, selected.version!);
                        onClose();
                      })
                    }
                  >
                    使用模板创建画布
                  </button>
                </>
              ) : (
                <>
                  {selected.source && (
                    <div className="canvas-prompt-source">
                      <span>
                        来源：
                        <a
                          href={selected.source.url}
                          onClick={(e) => {
                            e.preventDefault();
                            void perform(async () => {
                              await api.openExternalLink(selected.source!.url);
                            });
                          }}
                        >
                          {selected.source.name}
                        </a>{' '}
                        · {selected.source.author}
                      </span>
                      <small>
                        版本 {selected.source.revision.slice(0, 12)} · {selected.source.changes}
                      </small>
                      {selected.category === 'AI-drwa · 执行规范' && (
                        <small>
                          执行规范需配合对应的完整原始模板与统一适配规则使用；文中的项目路径需按实际工作区准备。
                        </small>
                      )}
                    </div>
                  )}
                  <pre className="canvas-prompt-content" tabIndex={0} aria-label="提示词全文">
                    {selected.content}
                  </pre>
                  {promptVariables(selected.content).map((name) => (
                    <label key={name}>
                      {name}
                      <textarea
                        aria-label={`变量 ${name}`}
                        value={values[name] ?? ''}
                        onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                      />
                    </label>
                  ))}
                  <div className="canvas-inline-actions">
                    <button onClick={() => insert(false)}>插入为文本节点</button>
                    <button onClick={() => insert(true)}>填入选中节点</button>
                    <button
                      onClick={() => {
                        setTitle(selected.title);
                        setContent(selected.content);
                        setTags(selected.tags.join(', '));
                        setEditing(true);
                      }}
                    >
                      {selected.version ? '编辑' : '另存为自定义'}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <p>
              {mode === 'template'
                ? '选择已保存的模板，或先在画布工具栏“保存为模板”。'
                : '选择提示词，填写变量后插入画布。自定义内容保存在内容库的“画布提示词”目录。'}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      </div>
    </Modal>
  );
}
