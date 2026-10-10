import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  Maximize2,
  Minimize2,
  Quote,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { Root, RootContent } from 'hast';
import type { Project, TongzhouAPI } from '../../shared/types';
import { diffLines, type ChangeScope } from '../../shared/project-context';
import { highlight } from '../../components/markdown/highlight';
import { Markdown } from '../../components/markdown/RichMarkdown';
import { HtmlPreview } from '../../components/markdown/HtmlPreview';
import { WorkspaceFileContext } from './WorkspaceFileContext';
import './project-context.css';

// Keyed effects ignore responses from a previously selected file/project/search.
function useResource<T>(key: string, load: () => Promise<T>, revision: number) {
  const [state, setState] = useState<{ key: string; value?: T; error?: string; loading: boolean }>({
    key,
    loading: true,
  });
  useEffect(() => {
    let active = true;
    if (!key) {
      setState({ key, loading: false });
      return;
    }
    setState((old) => ({ key, value: old.key === key ? old.value : undefined, loading: true }));
    void load().then(
      (value) => {
        if (active) setState({ key, value, loading: false });
      },
      (error) => {
        if (active) setState({ key, error: String(error), loading: false });
      },
    );
    return () => {
      active = false;
    };
  }, [key, revision]);
  return state.key === key ? state : { key, loading: !!key, value: undefined, error: undefined };
}
const statusName: Record<string, string> = {
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  '?': '未跟踪',
  U: '冲突',
  T: '类型变更',
};
const languageFor = (file: string) => {
  const ext = file.split('.').pop()?.toLowerCase() || '';
  return (
    (
      {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        py: 'python',
        rs: 'rust',
        md: 'markdown',
        markdown: 'markdown',
        mdown: 'markdown',
        yml: 'yaml',
        sh: 'bash',
        ps1: 'powershell',
        cs: 'csharp',
        vue: 'xml',
        html: 'xml',
        svg: 'xml',
      } as Record<string, string>
    )[ext] || ext
  );
};
function tokenLines(tree: Root): ReactNode[][] {
  const rows: ReactNode[][] = [[]];
  const visit = (nodes: RootContent[], classes: string[] = []) => {
    for (const n of nodes) {
      if (n.type === 'element')
        visit(n.children, [...classes, ...((n.properties.className as string[]) || [])]);
      if (n.type === 'text')
        n.value.split('\n').forEach((part, i) => {
          if (i) rows.push([]);
          const row = rows.at(-1)!;
          row.push(
            <span key={row.length} className={classes.join(' ')}>
              {part}
            </span>,
          );
        });
    }
  };
  visit(tree.children);
  return rows;
}
function Source({
  path,
  text,
  line,
  onLine,
}: {
  path: string;
  text: string;
  line: number;
  onLine: (n: number) => void;
}) {
  const [colored, setColored] = useState<{ text: string; lines: ReactNode[][] }>();
  const [limit, setLimit] = useState(600);
  useEffect(() => {
    let active = true;
    void highlight(text, languageFor(path)).then((tree) => {
      if (active && tree) setColored({ text, lines: tokenLines(tree) });
    });
    return () => {
      active = false;
    };
  }, [text, path]);
  useEffect(() => {
    setLimit(Math.max(600, line + 100));
  }, [path, line]);
  useEffect(() => {
    if (line)
      document.querySelector('.project-source .selected')?.scrollIntoView({ block: 'nearest' });
  }, [line, limit]);
  const lines = text.split('\n');
  return (
    <div className="project-source" aria-label="文件源码">
      {lines.slice(0, limit).map((content, i) => (
        <div key={i} className={'source-line ' + (line === i + 1 ? 'selected' : '')}>
          <button
            title={`引用第 ${i + 1} 行`}
            aria-label={`选择第 ${i + 1} 行`}
            onClick={() => onLine(i + 1)}
          >
            {i + 1}
          </button>
          <code>
            {colored?.text === text ? colored.lines[i] : content}
            {!content && '\u200b'}
          </code>
        </div>
      ))}
      {lines.length > limit && (
        <button className="project-more" onClick={() => setLimit(limit + 600)}>
          继续显示（剩余 {lines.length - limit} 行）
        </button>
      )}
    </div>
  );
}
function Feedback({
  error,
  loading,
  empty,
}: {
  error?: string;
  loading?: boolean;
  empty?: string;
}) {
  return error ? (
    <p className="project-error" role="alert">
      {error}
    </p>
  ) : loading ? (
    <p className="project-hint" role="status">
      正在读取…
    </p>
  ) : empty ? (
    <p className="project-hint">{empty}</p>
  ) : null;
}
export function ProjectContext({
  project,
  sessionId,
  running,
  api,
  onClose,
  onReference,
  onNotice,
  embedded = false,
  activeTab,
  fileRequest,
}: {
  project: Project;
  sessionId: string;
  running: boolean;
  api: TongzhouAPI;
  onClose: () => void;
  onReference: (text: string) => void;
  onNotice: (text: string) => void;
  embedded?: boolean;
  activeTab?: 'files' | 'changes';
  fileRequest?: { path: string; line: number; key: number };
}) {
  const storageKey = `tongzhou-project-panel-${sessionId}-${project.id}-${activeTab ?? 'files'}`;
  const [saved] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {};
    } catch {
      return {};
    }
  });
  const textValue = (name: string) => (typeof saved[name] === 'string' ? saved[name] : '');
  const [tab, setTab] = useState<'files' | 'changes' | 'instructions'>(
    activeTab ?? (saved.tab === 'instructions' ? 'instructions' : 'files'),
  );
  const [expanded, setExpanded] = useState(
    () => localStorage.getItem('tongzhou-context-wide') === 'true',
  );
  const [revision, setRevision] = useState(0);
  const [directory, setDirectory] = useState(textValue('directory'));
  const [query, setQuery] = useState(textValue('query'));
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'path' | 'content'>(
    saved.mode === 'content' ? 'content' : 'path',
  );
  const [selected, setSelected] = useState(textValue('selected'));
  const [line, setLine] = useState(Number.isFinite(saved.line) ? saved.line : 0);
  const [scope, setScope] = useState<ChangeScope>(saved.scope === 'staged' ? 'staged' : 'unstaged');
  const [changedFile, setChangedFile] = useState(textValue('changedFile'));
  const [diffLine, setDiffLine] = useState<{ line: number; side: '旧' | '新' }>();
  const [generating, setGenerating] = useState(false);
  const [wrap, setWrap] = useState(saved.wrap !== false);
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>(
    saved.previewMode === 'source' || line > 0 ? 'source' : 'preview',
  );
  const isMarkdown = languageFor(selected) === 'markdown';
  const isHtml = /\.html?$/i.test(selected);
  const documentPreview = (isMarkdown || isHtml) && previewMode === 'preview';
  const [handledRequest, setHandledRequest] = useState(saved.handledRequest ?? 0);
  useEffect(() => {
    if (!fileRequest || fileRequest.key === handledRequest) return;
    setTab('files');
    setSelected(fileRequest.path);
    setLine(fileRequest.line);
    setPreviewMode(fileRequest.line > 0 ? 'source' : 'preview');
    setHandledRequest(fileRequest.key);
  }, [fileRequest, handledRequest]);
  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        tab,
        directory,
        query,
        mode,
        selected,
        line,
        scope,
        changedFile,
        handledRequest,
        previewMode,
        wrap,
      }),
    );
  }, [
    storageKey,
    tab,
    directory,
    query,
    mode,
    selected,
    line,
    scope,
    changedFile,
    handledRequest,
    previewMode,
    wrap,
  ]);
  const refresh = () => setRevision((n) => n + 1);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    const timer = running ? setInterval(refresh, 5000) : undefined;
    refresh();
    return () => {
      window.removeEventListener('focus', refresh);
      clearInterval(timer);
    };
  }, [running]);
  const entries = useResource(
    tab === 'files' && !search ? 'files:' + directory : '',
    () => api.listFiles(project.id, directory),
    revision,
  );
  const results = useResource(
    tab === 'files' && search ? mode + ':' + search : '',
    () => api.projectSearch(project.id, search, mode),
    revision,
  );
  const source = useResource(
    selected ? 'source:' + selected : '',
    () => api.readFile(project.id, selected),
    revision,
  );
  const changes = useResource(
    tab === 'changes' ? 'changes:' + scope : '',
    () => api.projectChanges(project.id, scope),
    revision,
  );
  const patch = useResource(
    tab === 'changes' && changedFile ? scope + ':' + changedFile : '',
    () => api.projectPatch(project.id, changedFile, scope),
    revision,
  );
  const instructions = useResource(
    tab === 'instructions' ? 'instructions' : '',
    () => api.projectInstructions(project.id),
    revision,
  );
  const parsed = useMemo(() => diffLines(patch.value?.patch || ''), [patch.value?.patch]);
  const added = parsed.filter((l) => l.kind === 'add').length,
    removed = parsed.filter((l) => l.kind === 'remove').length;
  const openFile = (file: string, at = 0) => {
    setSelected(file);
    setLine(at);
    setPreviewMode(at > 0 ? 'source' : 'preview');
  };
  const reference = (file: string, at = 0) =>
    onReference(`请查看项目文件 ${JSON.stringify(file)}${at ? ` 第 ${at} 行` : ''}：\n`);
  const safely = (action: () => Promise<unknown>) =>
    void action().catch((e) => onNotice(String(e)));
  const changeTab = (next: typeof tab) => {
    setTab(next);
    setSelected('');
    setLine(0);
  };
  const loading =
    entries.loading ||
    results.loading ||
    source.loading ||
    changes.loading ||
    patch.loading ||
    instructions.loading;
  return (
    <aside
      className={`context-panel project-context ${embedded ? 'embedded' : ''} ${expanded ? 'wide' : ''} ${wrap ? 'wrap-code' : ''}`}
      aria-label="项目上下文"
    >
      {!embedded && (
        <header className="project-panel-heading">
          <div>
            <strong>{project.name}</strong>
            <span title={project.path}>{project.path}</span>
          </div>
          <button
            className="icon-button"
            aria-label={expanded ? '缩小项目面板' : '加宽项目面板'}
            title={expanded ? '缩小' : '加宽'}
            onClick={() => {
              setExpanded(!expanded);
              localStorage.setItem('tongzhou-context-wide', String(!expanded));
            }}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-button" aria-label="关闭项目面板" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
      )}
      <div className="project-tabs" role="tablist" aria-label="项目功能">
        {(
          [
            ['files', '文件', Folder],
            ['changes', '变更', GitBranch],
            ['instructions', '说明', FileText],
          ] as const
        )
          .filter(
            ([id]) => !embedded || (activeTab === 'changes' ? id === 'changes' : id !== 'changes'),
          )
          .map(([id, label, Icon]) => (
            <button role="tab" aria-selected={tab === id} key={id} onClick={() => changeTab(id)}>
              <Icon size={13} />
              {label}
            </button>
          ))}
        <button
          className="icon-button"
          aria-label="刷新项目上下文"
          title="刷新"
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="project-panel-body" role="tabpanel">
        {tab === 'files' && !selected && (
          <>
            <div className="project-search">
              <Search size={14} />
              <input
                aria-label="搜索项目文件"
                placeholder={mode === 'path' ? '搜索文件路径…' : '搜索文件内容…'}
                value={query}
                maxLength={500}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                aria-label="项目搜索方式"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="path">文件名</option>
                <option value="content">内容</option>
              </select>
            </div>
            {search ? (
              <>
                <Feedback
                  error={results.error}
                  loading={results.loading}
                  empty={
                    !results.value?.matches.length
                      ? '没有匹配的文件。搜索遵循项目忽略规则。'
                      : undefined
                  }
                />
                {results.value?.matches.map((item, i) => (
                  <button
                    className="project-file-row search-result"
                    key={i}
                    onClick={() => openFile(item.path, item.line)}
                  >
                    <FileCode2 size={14} />
                    <span>
                      <b>
                        {item.path}
                        {item.line ? ':' + item.line : ''}
                      </b>
                      {item.text && <small>{item.text}</small>}
                    </span>
                  </button>
                ))}
                {results.value?.truncated && (
                  <p className="project-hint">仅显示前 100 项，请缩小搜索范围。</p>
                )}
              </>
            ) : (
              <>
                <div className="project-breadcrumb">
                  <button onClick={() => setDirectory('')}>根目录</button>
                  {directory && (
                    <>
                      <span title={directory}>{directory}</span>
                      <button
                        className="icon-button"
                        title="上一级目录"
                        aria-label="上一级目录"
                        onClick={() =>
                          setDirectory(directory.split(/[\\/]/).slice(0, -1).join('/'))
                        }
                      >
                        <ArrowLeft size={13} />
                      </button>
                    </>
                  )}
                </div>
                <Feedback
                  error={entries.error}
                  loading={entries.loading}
                  empty={!entries.value?.length ? '此目录为空' : undefined}
                />
                {entries.value?.map((item) => (
                  <button
                    className="project-file-row"
                    key={item.path}
                    data-directory={item.directory}
                    onClick={() => (item.directory ? setDirectory(item.path) : openFile(item.path))}
                  >
                    {item.directory ? <Folder size={14} /> : <FileCode2 size={14} />}
                    <span>{item.name}</span>
                  </button>
                ))}
                {entries.value?.length === 500 && (
                  <p className="project-hint">仅显示前 500 项，可使用搜索定位。</p>
                )}
              </>
            )}
          </>
        )}
        {selected && (
          <section className="project-preview">
            <div className="project-preview-bar">
              <button
                className="icon-button"
                aria-label="返回文件列表"
                onClick={() => setSelected('')}
              >
                <ArrowLeft size={14} />
              </button>
              <span title={selected}>{selected}</span>
              <button
                className="icon-button"
                aria-label="复制文件路径"
                title="复制路径"
                onClick={() =>
                  safely(async () => {
                    await api.copyText(selected);
                    onNotice('已复制文件路径');
                  })
                }
              >
                <Copy size={13} />
              </button>
              <button
                className="icon-button"
                aria-label="引用文件到会话"
                title="引用到会话"
                onClick={() => reference(selected, line)}
              >
                <Quote size={14} />
              </button>
            </div>
            <div className="project-preview-options">
              <span>
                {source.value !== undefined
                  ? `${source.value.split('\n').length} 行 · ${languageFor(selected)}`
                  : '只读预览'}
                {line ? ` · 已选第 ${line} 行` : ''}
              </span>
              <div className="project-preview-actions">
                {(isMarkdown || isHtml) && (
                  <div className="project-preview-modes" role="tablist" aria-label="文件显示方式">
                    {(['preview', 'source'] as const).map((mode) => (
                      <button
                        key={mode}
                        role="tab"
                        aria-selected={previewMode === mode}
                        onClick={() => {
                          setPreviewMode(mode);
                          if (mode === 'preview') setLine(0);
                        }}
                      >
                        {mode === 'preview' ? '预览' : '源码'}
                      </button>
                    ))}
                  </div>
                )}
                {!documentPreview && (
                  <button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
                    换行
                  </button>
                )}
              </div>
            </div>
            <Feedback error={source.error} loading={source.loading} />
            {source.value !== undefined &&
              (documentPreview && isHtml ? (
                <HtmlPreview key={selected} text={source.value} />
              ) : documentPreview ? (
                <section className="project-document" aria-label="Markdown 预览">
                  <WorkspaceFileContext.Provider
                    value={{ root: project.path, file: selected, open: openFile }}
                  >
                    <Markdown text={source.value} />
                  </WorkspaceFileContext.Provider>
                </section>
              ) : (
                <Source
                  key={selected}
                  path={selected}
                  text={source.value}
                  line={line}
                  onLine={setLine}
                />
              ))}
          </section>
        )}
        {tab === 'changes' && (
          <>
            <div className="project-change-controls">
              <select
                aria-label="变更范围"
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as ChangeScope);
                  setChangedFile('');
                  setDiffLine(undefined);
                }}
              >
                <option value="unstaged">未暂存（含新文件）</option>
                <option value="staged">已暂存</option>
              </select>
              <span title={changes.value?.branch}>
                <GitBranch size={12} />
                {changes.value?.branch || 'Git'}
              </span>
            </div>
            <Feedback error={changes.error} loading={changes.loading} />
            {changes.value && !changes.value.repository ? (
              <div className="project-hint">
                此文件夹尚未使用 Git。
                <button
                  className="project-text-action"
                  onClick={() =>
                    onReference(
                      '请为当前项目初始化 Git，先检查忽略配置，确保不提交密钥和本地数据。',
                    )
                  }
                >
                  让同舟初始化仓库
                </button>
              </div>
            ) : (
              <>
                <div className="project-change-summary">
                  <span>{changes.value?.changes.length || 0} 个文件</span>
                  <button
                    disabled={!changes.value?.changes.length}
                    onClick={() =>
                      onReference(
                        `请审阅当前项目${scope === 'staged' ? '已暂存' : '未暂存（含未跟踪文件）'}的 Git 变更，先列出有证据的问题与文件行号，不修改代码。`,
                      )
                    }
                  >
                    请同舟审阅
                  </button>
                </div>
                {!changes.loading && !changes.error && !changes.value?.changes.length && (
                  <p className="project-hint">
                    <Check size={16} /> 当前范围没有变更。
                  </p>
                )}
                <div className="project-change-list">
                  {changes.value?.changes.map((item) => (
                    <button
                      className={'project-file-row ' + (changedFile === item.path ? 'active' : '')}
                      key={item.path}
                      onClick={() => {
                        setChangedFile(item.path);
                        setDiffLine(undefined);
                      }}
                      title={item.previousPath ? `${item.previousPath} → ${item.path}` : item.path}
                    >
                      <span className={'git-status status-' + item.status}>{item.status}</span>
                      <span>{item.path}</span>
                      <small>{statusName[item.status] || item.status}</small>
                    </button>
                  ))}
                </div>
                {changes.value?.truncated && (
                  <p className="project-hint">变更超过 1,000 个文件，仅显示部分列表。</p>
                )}
                {changedFile && (
                  <section className="project-diff">
                    <div className="project-preview-bar">
                      <span title={changedFile}>{changedFile}</span>
                      <span className="diff-count">
                        <b>+{added}</b>
                        <i>−{removed}</i>
                      </span>
                      <button
                        className="icon-button"
                        aria-label="查看变更文件源码"
                        title="查看当前源码"
                        onClick={() => {
                          setTab('files');
                          openFile(changedFile);
                        }}
                      >
                        <FileCode2 size={14} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="反馈此处变更"
                        title="引用变更到会话"
                        onClick={() =>
                          onReference(
                            `请检查 ${scope === 'staged' ? '已暂存' : '未暂存'}变更中的文件 ${JSON.stringify(changedFile)}${diffLine ? `（${diffLine.side}版本第 ${diffLine.line} 行）` : ''}：\n`,
                          )
                        }
                      >
                        <Quote size={14} />
                      </button>
                    </div>
                    <div className="project-preview-options">
                      <span>
                        {diffLine
                          ? `已选${diffLine.side}版本第 ${diffLine.line} 行`
                          : '点击行号选择反馈位置'}
                      </span>
                      <button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
                        换行
                      </button>
                    </div>
                    <Feedback error={patch.error} loading={patch.loading} />
                    {patch.value?.binary ? (
                      <p className="project-hint">
                        此文件包含二进制内容或体积过大，无法显示文本差异。
                      </p>
                    ) : (
                      <div className="project-diff-lines" aria-label="文件差异">
                        {parsed.map((item, i) => (
                          <div
                            key={i}
                            className={`diff-line ${item.kind} ${diffLine && (diffLine.side === '新' ? item.newLine === diffLine.line : item.oldLine === diffLine.line) ? 'selected' : ''}`}
                          >
                            <button
                              disabled={!item.oldLine}
                              aria-label={
                                item.oldLine ? `选择旧版本第 ${item.oldLine} 行` : undefined
                              }
                              onClick={() => setDiffLine({ line: item.oldLine!, side: '旧' })}
                            >
                              {item.oldLine || ''}
                            </button>
                            <button
                              disabled={!item.newLine}
                              aria-label={
                                item.newLine ? `选择新版本第 ${item.newLine} 行` : undefined
                              }
                              onClick={() => setDiffLine({ line: item.newLine!, side: '新' })}
                            >
                              {item.newLine || ''}
                            </button>
                            <code>{item.text || '\u200b'}</code>
                          </div>
                        ))}
                      </div>
                    )}
                    {patch.value?.truncated && (
                      <p className="project-hint">
                        差异过大，预览已截断。请让同舟按文件进一步检查。
                      </p>
                    )}
                  </section>
                )}
                <p className="project-footnote">显示当前工作目录的全部变更，包含你和同舟的修改。</p>
              </>
            )}
          </>
        )}
        {tab === 'instructions' && !selected && (
          <>
            <div className="project-instructions-intro">
              <strong>项目说明</strong>
              <p>
                AGENTS.md / agent.md 记录开发约定；README
                说明项目用法。先查看已有内容，再按需要补充。
              </p>
            </div>
            <Feedback error={instructions.error} loading={instructions.loading} />
            {instructions.value?.map((item) => (
              <button
                className="project-file-row"
                key={item.path}
                onClick={() => openFile(item.path)}
              >
                <FileText size={14} />
                <span>{item.path}</span>
                <small>查看</small>
              </button>
            ))}
            {!instructions.loading &&
              !instructions.value?.some((item) => /^agents?\.md$/i.test(item.path)) && (
                <p className="project-hint">尚未发现项目根目录的 Agent 说明。</p>
              )}
            <div className="project-instruction-actions">
              <button
                className="button"
                disabled={generating || instructions.loading}
                onClick={() => {
                  setGenerating(true);
                  void (async () => {
                    const existing = instructions.value?.find((f) => /^agents?\.md$/i.test(f.path));
                    if (existing) {
                      openFile(existing.path);
                      return;
                    }
                    const result = await api.initializeAgent(project.id);
                    onNotice(
                      result.created
                        ? '已生成项目说明，请核对并补充业务约定'
                        : '已找到现有说明，未覆盖',
                    );
                    const list = await api.projectInstructions(project.id);
                    const item = list.find((f) => /^agents?\.md$/i.test(f.path));
                    refresh();
                    if (item) openFile(item.path);
                  })()
                    .catch((e) => onNotice(String(e)))
                    .finally(() => setGenerating(false));
                }}
              >
                {generating
                  ? '正在生成…'
                  : instructions.value?.some((item) => /^agents?\.md$/i.test(item.path))
                    ? '查看 Agent 说明'
                    : '生成基础说明'}
              </button>
              <button
                className="button"
                onClick={() =>
                  onReference(
                    '请阅读当前项目代码、README 和已有 AGENTS.md / agent.md，补充准确的项目说明，包括启动、测试命令、目录职责和开发约定；保留已有有效规则，不编造未验证的命令。',
                  )
                }
              >
                让同舟完善说明
              </button>
            </div>
            <p className="project-footnote">
              基础说明根据目录和配置生成，不覆盖已有文件。操作文件与命令仍遵循当前会话权限。
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
