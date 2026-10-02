import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Globe2,
  Layers3,
  LayoutPanelLeft,
  MessageSquare,
  MoreHorizontal,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type {
  AgentProfile,
  FileEntry,
  ImportPreview,
  Message,
  ProviderInput,
  Session,
  Snapshot,
} from './shared/types';
import { ChatMessage, Field, Mark, Modal, Spinner } from './components';
const empty: Snapshot = {
  providers: [],
  agents: [],
  projects: [],
  sessions: [],
  runs: [],
  approvals: [],
};
const protocolLabels: Record<string, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  gemini: 'Google Gemini',
  codex: 'Codex · ChatGPT',
};
const presets = [
  {
    name: '自定义服务',
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    auth: 'api-key',
    models: [],
  },
  {
    name: 'OpenAI API',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'api-key',
    models: [],
  },
  {
    name: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    auth: 'api-key',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    name: '通义千问',
    protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    auth: 'api-key',
    models: ['qwen-plus'],
  },
  {
    name: 'Kimi',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    auth: 'api-key',
    models: [],
  },
  {
    name: '智谱 GLM',
    protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    auth: 'api-key',
    models: [],
  },
  {
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    auth: 'api-key',
    models: [],
  },
  {
    name: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: 'api-key',
    models: [],
  },
  {
    name: 'Ollama / 本地',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    auth: 'none',
    models: [],
  },
] as const;
type View = 'workspace' | 'providers' | 'agents' | 'activity' | 'settings';
export default function App() {
  const api = window.tongzhou;
  const [data, setData] = useState<Snapshot>(empty);
  const [view, setView] = useState<View>('workspace');
  const [sessionId, setSessionId] = useState('');
  const sessionRef = useRef('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [agentId, setAgentId] = useState('builder');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [providerEdit, setProviderEdit] = useState<ProviderInput | null>(null);
  const [agentEdit, setAgentEdit] = useState<AgentProfile | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamIds, setTeamIds] = useState<string[]>(['reviewer', 'architect']);
  const [rename, setRename] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [contextTab, setContextTab] = useState<'files' | 'diff'>('files');
  const [filePath, setFilePath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [fileView, setFileView] = useState<{ path: string; content: string } | null>(null);
  const [diff, setDiff] = useState('');
  const [codex, setCodex] = useState<{
    available: boolean;
    account: string;
    error?: string;
  } | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const session = data.sessions.find((s) => s.id === sessionId);
  const project = data.projects.find((p) => p.id === session?.projectId);
  const provider = data.providers.find((p) => p.id === providerId);
  const running = data.runs.find((r) => r.sessionId === sessionId && r.status === 'running');
  const activateSession = (selected: Session) => {
    sessionRef.current = selected.id;
    setSessionId(selected.id);
    setProviderId(selected.providerId);
    setModel(selected.model);
    setAgentId(data.agents.some((a) => a.id === selected.agentId) ? selected.agentId : 'builder');
    setView('workspace');
  };
  const refresh = useCallback(async () => {
    if (api) setData(await api.snapshot());
  }, [api]);
  const report = (e: unknown) =>
    setNotice(
      e instanceof Error
        ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        : String(e),
    );
  const perform = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      report(e);
    }
  };
  useEffect(() => {
    if (!api) return;
    void refresh().catch(report);
    return api.onEvent((event) => {
      if (event.type === 'message' && event.message.sessionId === sessionRef.current)
        setMessages((old) => {
          const i = old.findIndex((m) => m.id === event.message.id);
          if (i < 0) return [...old, event.message];
          return old.map((m, j) => (j === i ? event.message : m));
        });
      if (event.type !== 'message' && !refreshTimer.current)
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          void refresh().catch(report);
        }, 80);
    });
  }, [api, refresh]);
  useEffect(() => {
    sessionRef.current = sessionId;
    setFilePath('');
    setFileView(null);
    if (sessionId)
      void api
        .messages(sessionId)
        .then((result) => {
          if (sessionRef.current === sessionId) setMessages(result);
        })
        .catch(report);
    else setMessages([]);
  }, [sessionId, api]);
  useEffect(() => {
    if (!providerId && data.providers.length) setProviderId(data.providers[0].id);
  }, [providerId, data.providers]);
  useEffect(() => {
    const el = feed.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 300)
      el.scrollTo({ top: el.scrollHeight });
  }, [messages]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (project && view === 'workspace')
      void (
        contextTab === 'files'
          ? api.listFiles(project.id, filePath).then(setEntries)
          : api.diff(project.id).then(setDiff)
      ).catch((e) => {
        if (contextTab === 'diff') setDiff(String(e));
        else report(e);
      });
  }, [project?.id, filePath, contextTab, view, running?.id]);
  const newSession = async (projectId?: string) => {
    await perform(async () => {
      let id = projectId ?? project?.id ?? data.projects[0]?.id;
      if (!id) {
        const p = await api.addProject();
        if (!p) return;
        id = p.id;
      }
      const s = await api.createSession(id);
      activateSession(s);
      await refresh();
    });
  };
  const openProject = () =>
    perform(async () => {
      const p = await api.addProject();
      if (p) await newSession(p.id);
    });
  const send = async (team = false) => {
    if (!sessionId || !draft.trim() || !model.trim()) return;
    setBusy(true);
    try {
      const input = { sessionId, prompt: draft, providerId, model, agentId };
      if (team) await api.team(input, teamIds);
      else await api.run(input);
      setDraft('');
      setTeamOpen(false);
      await refresh();
      setTimeout(
        () => feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' }),
        50,
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const editNewProvider = () =>
    setProviderEdit({
      id: crypto.randomUUID(),
      name: '',
      protocol: 'openai-chat',
      baseUrl: '',
      auth: 'api-key',
      models: [],
      maxOutputTokens: 8192,
      contextChars: 100000,
    });
  const normalizedProvider = () => ({
    ...providerEdit!,
    models: providerEdit!.models.map((m) => m.trim()).filter(Boolean),
  });
  const saveProvider = async (test = false) => {
    if (!providerEdit) return;
    setBusy(true);
    try {
      const saved = await api.saveProvider(normalizedProvider());
      await refresh();
      if (test) {
        const result = await api.testProvider(saved.id, saved.models[0] ?? model);
        setNotice(result);
        setProviderEdit({ ...saved, secret: '' });
      } else {
        setProviderEdit(null);
        setNotice('连接已保存');
      }
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const fetchModels = async () => {
    if (!providerEdit) return;
    setBusy(true);
    try {
      const saved = await api.saveProvider(normalizedProvider());
      const models = await api.models(saved.id);
      setProviderEdit({ ...saved, models, secret: '' });
      setNotice(`已发现 ${models.length} 个模型，保存后生效`);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const nav = [
    { id: 'workspace', label: '工作空间', icon: MessageSquare },
    { id: 'providers', label: '模型连接', icon: Network },
    { id: 'agents', label: 'Agent 团队', icon: Users },
    { id: 'activity', label: '运行记录', icon: Activity },
  ] as const;
  const statusLabel = (s: string) =>
    ({ running: '运行中', completed: '已完成', interrupted: '已停止', failed: '失败' })[s] ?? s;
  if (!api)
    return (
      <div className="browser-fallback">
        <Mark />
        <h1>同舟 Tongzhou</h1>
        <p>
          请使用桌面应用打开。开发模式运行 <code>npm run dev</code>。
        </p>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <div>
            <strong>同舟</strong>
            <span>TONGZHOU</span>
          </div>
          <span className="version">0.1</span>
        </div>
        <button className="new-chat" onClick={() => newSession()}>
          <Plus size={17} />
          开启新会话<span>↗</span>
        </button>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? 'active' : ''}
              onClick={() => setView(n.id)}
            >
              <n.icon size={17} />
              {n.label}
              {n.id === 'providers' && <span className="nav-count">{data.providers.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="section-label">
          项目空间
          <button aria-label="打开项目" onClick={openProject}>
            <Plus size={15} />
          </button>
        </div>
        <div className="project-list">
          {data.projects.map((p) => (
            <button
              key={p.id}
              className={project?.id === p.id ? 'selected' : ''}
              title={p.path}
              onClick={() => newSession(p.id)}
            >
              <Folder size={15} />
              <span>{p.name}</span>
              <ChevronRight size={13} />
            </button>
          ))}
          {!data.projects.length && (
            <button className="subtle" onClick={openProject}>
              <FolderOpen size={15} />
              添加第一个项目
            </button>
          )}
        </div>
        <div className="section-label history-label">
          {archived ? '已归档会话' : '最近会话'}
          <button
            aria-label="切换归档会话"
            title="切换归档会话"
            onClick={() => setArchived(!archived)}
          >
            <Archive size={14} />
          </button>
        </div>
        <div className="search-box">
          <Search size={13} />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="session-list">
          {data.sessions
            .filter(
              (s) => s.archived === archived && s.title.toLowerCase().includes(query.toLowerCase()),
            )
            .map((s) => (
              <button
                key={s.id}
                className={sessionId === s.id && view === 'workspace' ? 'selected' : ''}
                onClick={() => {
                  activateSession(s);
                }}
              >
                <span
                  className={
                    'session-dot ' +
                    (data.runs.some((r) => r.sessionId === s.id && r.status === 'running')
                      ? 'live'
                      : '')
                  }
                />
                <span>
                  {s.parentId ? '↳ ' : ''}
                  {s.title}
                </span>
              </button>
            ))}
          {!data.sessions.length && <p className="sidebar-empty">想法从这里开始。</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="live-dot" />
            本地优先<span>你的数据，你掌控</span>
          </div>
          <button
            onClick={() => setView('settings')}
            className={view === 'settings' ? 'active' : ''}
          >
            <Settings2 size={17} />
            设置与关于
            <CircleHelp size={15} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <LayoutPanelLeft size={17} />
            <span>同舟</span>
            <ChevronRight size={13} />
            <strong>
              {view === 'workspace'
                ? (project?.name ?? '工作空间')
                : {
                    providers: '模型连接',
                    agents: 'Agent 团队',
                    activity: '运行记录',
                    settings: '设置与关于',
                  }[view]}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <ShieldCheck size={13} />
              本地存储
            </span>
            <span className="avatar">T</span>
          </div>
        </header>
        {view === 'workspace' && (
          <div className="workspace-layout">
            <main className="conversation">
              {session && (
                <div className="conversation-header">
                  <div>
                    <h2>{session.title}</h2>
                    <span>{project?.path}</span>
                  </div>
                  <div className="row">
                    <button
                      className="icon-button"
                      aria-label="重命名会话"
                      title="重命名"
                      onClick={() => setRename(session.title)}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="导出会话"
                      title="导出 Markdown"
                      onClick={() =>
                        perform(async () => {
                          const f = await api.exportSession(sessionId);
                          if (f) setNotice('会话已导出');
                        })
                      }
                    >
                      <ArrowDownToLine size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={session.archived ? '恢复会话' : '归档会话'}
                      title={session.archived ? '恢复' : '归档'}
                      onClick={() =>
                        perform(() => api.updateSession(sessionId, { archived: !session.archived }))
                      }
                    >
                      <Archive size={16} />
                    </button>
                  </div>
                </div>
              )}
              <div className={'feed ' + (!messages.length ? 'empty-feed' : '')} ref={feed}>
                {!messages.length ? (
                  <div className="welcome">
                    <div className="eyebrow">
                      <span /> ONE WORKSPACE. MANY MODELS.
                    </div>
                    <div className="welcome-mark">
                      <Mark />
                    </div>
                    <h1>
                      让想法，<span>同舟而行。</span>
                    </h1>
                    <p>
                      连接你喜欢的模型，让不同的 Agent 并肩协作。
                      <br />
                      从一个问题，到一个完成的项目。
                    </p>
                    <div className="welcome-actions">
                      {!session && (
                        <button className="primary" onClick={openProject}>
                          <FolderOpen size={16} />
                          打开项目，开始创作
                          <ArrowRight size={15} />
                        </button>
                      )}
                      <button className="text-button" onClick={() => setView('providers')}>
                        配置模型连接
                        <ArrowRight size={14} />
                      </button>
                    </div>
                    <div className="prompt-grid">
                      {[
                        {
                          icon: Code2,
                          title: '读懂一个项目',
                          text: '分析这个项目的结构、核心模块和运行方式。',
                        },
                        {
                          icon: GitBranch,
                          title: '一起规划实现',
                          text: '阅读项目，提出下一阶段最值得实现的功能与具体步骤。',
                        },
                        {
                          icon: ShieldCheck,
                          title: '发现潜在问题',
                          text: '审查项目中的代码，找出有证据的缺陷和测试缺口。',
                        },
                      ].map((p) => (
                        <button
                          key={p.title}
                          onClick={() => {
                            setDraft(p.text);
                            if (!session) setNotice('先打开一个项目，即可开始会话');
                          }}
                        >
                          <p.icon size={20} />
                          <strong>{p.title}</strong>
                          <span>{p.text}</span>
                          <ArrowRight size={15} />
                        </button>
                      ))}
                    </div>
                    <div className="welcome-foot">
                      <Layers3 size={14} />
                      {data.providers.length} 个模型连接<span>·</span>
                      <Bot size={14} />
                      {data.agents.length} 个 Agent<span>·</span>上下文随任务同行
                    </div>
                  </div>
                ) : (
                  messages.map((m) => <ChatMessage key={m.id} message={m} />)
                )}
              </div>
              <div className="composer-wrap">
                <div className={'composer ' + (running ? 'is-running' : '')}>
                  <textarea
                    aria-label="消息"
                    placeholder={
                      session
                        ? '描述你的想法，或让 Agent 接着完成任务…'
                        : '打开项目后，开始你的第一个任务…'
                    }
                    value={draft}
                    disabled={!session || session.archived}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (!running) void send();
                      }
                    }}
                  />
                  <div className="composer-toolbar">
                    <div className="composer-controls">
                      <select
                        aria-label="当前连接"
                        value={providerId}
                        onChange={(e) => {
                          setProviderId(e.target.value);
                          setModel(
                            data.providers.find((p) => p.id === e.target.value)?.models[0] ?? '',
                          );
                        }}
                        disabled={!!running}
                      >
                        <option value="" disabled>
                          选择连接
                        </option>
                        {data.providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <input
                        className="model-input"
                        list="model-options"
                        aria-label="当前模型"
                        placeholder="输入模型 ID"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        disabled={!!running}
                      />
                      <datalist id="model-options">
                        {provider?.models.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                      <select
                        aria-label="当前 Agent"
                        value={agentId}
                        onChange={(e) => setAgentId(e.target.value)}
                        disabled={!!running}
                      >
                        {data.agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="row">
                      <button
                        className="icon-button"
                        title="多 Agent 协作（只读分析）"
                        aria-label="多 Agent 协作"
                        disabled={!session || !draft.trim() || !!running || !model}
                        onClick={() => setTeamOpen(true)}
                      >
                        <Users size={18} />
                      </button>
                      {running ? (
                        <button
                          className="send-button stop"
                          aria-label="停止执行"
                          onClick={() => perform(() => api.cancel(sessionId))}
                        >
                          <Square size={15} fill="currentColor" />
                        </button>
                      ) : (
                        <button
                          className="send-button"
                          aria-label="发送消息"
                          disabled={
                            !session ||
                            !draft.trim() ||
                            !model.trim() ||
                            !providerId ||
                            busy ||
                            session.archived
                          }
                          onClick={() => send()}
                        >
                          {busy ? <Spinner /> : <ArrowUp size={20} />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="composer-caption">
                  <span>
                    {running ? (
                      <>
                        <span className="live-dot" />
                        {running.agentName} 正在工作
                      </>
                    ) : (
                      <>
                        <ShieldCheck size={12} />
                        文件修改与命令执行受权限控制
                      </>
                    )}
                  </span>
                  <span>Enter 发送 · Shift + Enter 换行</span>
                </div>
              </div>
            </main>
            <aside className="context-panel">
              <div className="context-title">
                <span>项目上下文</span>
                <FolderOpen size={16} />
              </div>
              <div className="context-tabs">
                <button
                  className={contextTab === 'files' ? 'active' : ''}
                  onClick={() => setContextTab('files')}
                >
                  文件
                </button>
                <button
                  className={contextTab === 'diff' ? 'active' : ''}
                  onClick={() => setContextTab('diff')}
                >
                  Git 变更
                </button>
                <button
                  aria-label="刷新文件"
                  className="icon-button"
                  onClick={() =>
                    perform(async () => {
                      if (project) {
                        if (contextTab === 'files')
                          setEntries(await api.listFiles(project.id, filePath));
                        else setDiff(await api.diff(project.id));
                      }
                    })
                  }
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {!project ? (
                <div className="context-empty">
                  <Folder size={32} />
                  <p>还没有打开项目</p>
                  <span>
                    添加项目后，在这里浏览文件
                    <br />
                    和查看代码变更。
                  </span>
                  <button onClick={openProject}>
                    选择文件夹
                    <Plus size={13} />
                  </button>
                </div>
              ) : contextTab === 'diff' ? (
                <pre className="diff-view">{diff || '暂无变更'}</pre>
              ) : (
                <>
                  <div className="file-breadcrumb">
                    <button onClick={() => setFilePath('')}>{project.name}</button>
                    {filePath && (
                      <>
                        <span>/ {filePath}</span>
                        <button
                          aria-label="上一级目录"
                          onClick={() =>
                            setFilePath(filePath.split(/[\\/]/).slice(0, -1).join('/'))
                          }
                        >
                          ↑
                        </button>
                      </>
                    )}
                  </div>
                  <div className="file-list">
                    {entries.map((f) => (
                      <button
                        key={f.path}
                        onClick={() =>
                          f.directory
                            ? setFilePath(f.path)
                            : perform(async () =>
                                setFileView({
                                  path: f.path,
                                  content: await api.readFile(project.id, f.path),
                                }),
                              )
                        }
                      >
                        {f.directory ? <Folder size={14} /> : <FileCode2 size={14} />}
                        <span>{f.name}</span>
                        {f.directory && <ChevronRight size={12} />}
                      </button>
                    ))}
                    {!entries.length && <p className="muted">此目录为空</p>}
                  </div>
                </>
              )}
              <div className="context-bottom">
                <div>
                  <span className="mini-icon">
                    <Bot size={17} />
                  </span>
                  <div>
                    <strong>为每项任务，选择合适的伙伴</strong>
                    <p>自定义模型、角色与执行权限</p>
                  </div>
                </div>
                <button onClick={() => setView('agents')}>
                  管理 Agent 团队
                  <ArrowRight size={14} />
                </button>
              </div>
            </aside>
          </div>
        )}
        {view === 'providers' && (
          <main className="page">
            <div className="page-heading">
              <div className="eyebrow">CONNECTIONS</div>
              <div className="page-title-row">
                <div>
                  <h1>让好模型，都在这里。</h1>
                  <p>使用你的账号、API 密钥或本地服务，统一连接。</p>
                </div>
                <div className="row">
                  <button
                    className="secondary"
                    onClick={() => perform(async () => setPreview(await api.importCCSwitch()))}
                  >
                    <ArrowDownToLine size={15} />
                    导入 CC Switch
                  </button>
                  <button className="primary" onClick={editNewProvider}>
                    <Plus size={16} />
                    添加连接
                  </button>
                </div>
              </div>
            </div>
            <div className="info-strip">
              <ShieldCheck size={17} />
              <span>
                API 密钥通过操作系统加密保存。每次运行使用独立配置，切换连接不会覆盖已有会话。
              </span>
            </div>
            <div className="provider-grid">
              {data.providers.map((p) => (
                <article className="provider-card" key={p.id}>
                  <div className="card-top">
                    <div className={'provider-icon ' + p.protocol}>
                      {p.protocol === 'codex' ? (
                        <Mark small />
                      ) : p.auth === 'none' ? (
                        <Terminal size={23} />
                      ) : (
                        <Globe2 size={23} />
                      )}
                    </div>
                    <span className="tag">
                      {p.protocol === 'codex'
                        ? '账号授权'
                        : p.auth === 'none'
                          ? '无需密钥'
                          : p.hasSecret
                            ? '已配置密钥'
                            : '待配置'}
                    </span>
                    <button
                      className="icon-button"
                      aria-label={'编辑 ' + p.name}
                      onClick={() => setProviderEdit({ ...p, secret: '' })}
                    >
                      <SlidersHorizontal size={17} />
                    </button>
                  </div>
                  <h3>{p.name}</h3>
                  <p>{protocolLabels[p.protocol]}</p>
                  <div className="provider-endpoint">
                    {p.baseUrl || '使用官方 Codex 登录与执行'}
                  </div>
                  <div className="card-footer">
                    <span>
                      <Layers3 size={13} />
                      {p.models.length ? `${p.models.length} 个模型` : '模型可手动填写或发现'}
                    </span>
                    <button onClick={() => setProviderEdit({ ...p, secret: '' })}>
                      管理
                      <ArrowRight size={13} />
                    </button>
                  </div>
                </article>
              ))}
              <button className="add-card" onClick={editNewProvider}>
                <Plus size={24} />
                <strong>连接下一个模型</strong>
                <span>兼容服务 · 国内模型 · 本地推理</span>
              </button>
            </div>
            <div className="section-note">
              <Network size={19} />
              <div>
                <strong>协议统一，能力保持透明</strong>
                <p>
                  支持 Chat Completions、Responses、Anthropic 与 Gemini
                  API。具体模型的工具调用能力需由服务支持；模型目录不代表账号已获得访问权限。
                </p>
              </div>
            </div>
          </main>
        )}
        {view === 'agents' && (
          <main className="page">
            <div className="page-heading">
              <div className="eyebrow">YOUR CREW</div>
              <div className="page-title-row">
                <div>
                  <h1>各有所长，一起向前。</h1>
                  <p>给每位 Agent 配置模型、职责和权限，让协作更有章法。</p>
                </div>
                <button
                  className="primary"
                  onClick={() =>
                    setAgentEdit({
                      id: crypto.randomUUID(),
                      name: '',
                      description: '',
                      instructions: '',
                      providerId: '',
                      model: '',
                      permission: 'read-only',
                      maxSteps: 16,
                    })
                  }
                >
                  <Plus size={16} />
                  创建 Agent
                </button>
              </div>
            </div>
            <div className="agent-grid">
              {data.agents.map((a, i) => (
                <article className="agent-card" key={a.id}>
                  <div className="card-top">
                    <span className={'agent-avatar tone-' + (i % 3)}>
                      <Bot size={25} />
                    </span>
                    <span className="tag">
                      {a.permission === 'read-only' ? '只读分析' : '审批后执行'}
                    </span>
                    <button
                      className="icon-button"
                      aria-label={'编辑 ' + a.name}
                      onClick={() => setAgentEdit(a)}
                    >
                      <SlidersHorizontal size={17} />
                    </button>
                  </div>
                  <h3>{a.name}</h3>
                  <p>{a.description}</p>
                  <div className="agent-instructions">{a.instructions}</div>
                  <div className="agent-detail">
                    <span>
                      <Layers3 size={13} />
                      {a.model || '继承会话模型'}
                    </span>
                    <span>
                      <Zap size={13} />
                      最多 {a.maxSteps} 步
                    </span>
                  </div>
                  <div className="card-footer">
                    <span>
                      {data.providers.find((p) => p.id === a.providerId)?.name ?? '继承会话连接'}
                    </span>
                    <button onClick={() => setAgentEdit(a)}>
                      配置
                      <ArrowRight size={13} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="section-note">
              <Users size={20} />
              <div>
                <strong>从同一个问题，获得不同视角</strong>
                <p>
                  在会话输入任务后点击协作按钮，同时运行最多 3 个
                  Agent。第一版的并行协作使用只读权限，结果回到主会话，由主助手继续实施。
                </p>
              </div>
            </div>
          </main>
        )}
        {view === 'activity' && (
          <main className="page">
            <div className="page-heading">
              <div className="eyebrow">OBSERVABILITY</div>
              <h1>每一步，都有迹可循。</h1>
              <p>查看实际执行状态、模型和服务返回的 Token 用量。</p>
            </div>
            <div className="stats-grid">
              {[
                { label: '累计运行', value: data.runs.length },
                { label: '进行中', value: data.runs.filter((r) => r.status === 'running').length },
                {
                  label: '输入 Tokens',
                  value: data.runs.reduce((s, r) => s + r.inputTokens, 0).toLocaleString(),
                },
                {
                  label: '输出 Tokens',
                  value: data.runs.reduce((s, r) => s + r.outputTokens, 0).toLocaleString(),
                },
              ].map((s) => (
                <div key={s.label}>
                  <span>{s.label}</span>
                  <strong>{s.value}</strong>
                </div>
              ))}
            </div>
            <div className="runs-table">
              <div className="table-head">
                <span>任务 / Agent</span>
                <span>模型</span>
                <span>状态</span>
                <span>时间</span>
                <span>Tokens</span>
              </div>
              {data.runs.map((r) => (
                <button
                  className="table-row"
                  key={r.id}
                  onClick={() => {
                    const selected = data.sessions.find((s) => s.id === r.sessionId);
                    if (selected) activateSession(selected);
                  }}
                >
                  <span>
                    <strong>
                      {data.sessions.find((s) => s.id === r.sessionId)?.title ?? '会话'}
                    </strong>
                    <small>{r.agentName}</small>
                  </span>
                  <span>{r.model}</span>
                  <span>
                    <i className={'status-pill ' + r.status}>{statusLabel(r.status)}</i>
                  </span>
                  <span>
                    {new Date(r.startedAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span>{r.inputTokens + r.outputTokens || '—'}</span>
                </button>
              ))}
              {!data.runs.length && (
                <div className="empty-state">
                  <Activity size={32} />
                  <h3>准备好启航</h3>
                  <p>开始一项任务后，运行记录会出现在这里。</p>
                  <button className="secondary" onClick={() => setView('workspace')}>
                    回到工作空间
                    <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </div>
            <p className="footnote">
              用量来自上游返回；“—”表示未报告或零用量，不代表免费。协作汇总记录不重复计算子任务
              Token。
            </p>
          </main>
        )}
        {view === 'settings' && (
          <main className="page settings-page">
            <div className="page-heading">
              <div className="eyebrow">BUILT FOR YOU</div>
              <h1>轻装出发，掌控在你。</h1>
              <p>同舟 0.1.0 · 开源多模型桌面工作台</p>
            </div>
            <section className="settings-card">
              <div className="settings-card-title">
                <Mark small />
                <div>
                  <h3>OpenAI / ChatGPT 登录</h3>
                  <p>使用独立的 Codex 配置目录，不改写你已有的 Codex 配置。</p>
                </div>
              </div>
              <div className="account-status">
                <span className={'live-dot ' + (!codex?.account ? 'gray' : '')} />
                {codex
                  ? codex.account || (codex.available ? 'Codex 可用，尚未登录' : 'Codex 未就绪')
                  : '点击刷新检查状态'}
                {codex?.error && <small>{codex.error}</small>}
              </div>
              <div className="row">
                <button
                  className="primary"
                  onClick={() => perform(async () => setNotice(await api.codexLogin()))}
                >
                  登录 ChatGPT
                  <ArrowRight size={15} />
                </button>
                <button
                  className="secondary"
                  onClick={() => perform(async () => setCodex(await api.codexStatus()))}
                >
                  <RefreshCw size={14} />
                  刷新状态
                </button>
                {codex?.account && (
                  <button
                    className="text-button danger"
                    onClick={() =>
                      perform(async () => {
                        await api.codexLogout();
                        setCodex(await api.codexStatus());
                      })
                    }
                  >
                    退出登录
                  </button>
                )}
              </div>
            </section>
            <section className="settings-card">
              <div className="settings-card-title">
                <ShieldCheck size={23} />
                <div>
                  <h3>权限与数据</h3>
                  <p>本地优先，模型调用直达你配置的服务。</p>
                </div>
              </div>
              <div className="settings-row">
                <span>会话与运行记录</span>
                <strong>本地 SQLite 数据库</strong>
              </div>
              <div className="settings-row">
                <span>API 密钥</span>
                <strong>操作系统加密存储</strong>
              </div>
              <div className="settings-row">
                <span>直接 API 执行</span>
                <strong>文件范围检查 + 操作审批</strong>
              </div>
              <div className="settings-row">
                <span>Codex 执行</span>
                <strong>Codex 原生沙箱与审批</strong>
              </div>
              <p className="footnote">
                直接 API
                模式的终端命令经你批准后，以当前系统用户权限运行；它不提供操作系统级沙箱。项目内容会发送给所选模型服务。第一版不包含云同步、自动更新或遥测。
              </p>
            </section>
            <section className="settings-card about-card">
              <Mark />
              <h3>多模型协作，一个工作台。</h3>
              <p>同舟 Tongzhou · Apache-2.0</p>
              <span>Built with Codex · Inspired by CC Switch</span>
            </section>
          </main>
        )}
      </div>
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button aria-label="关闭提示" onClick={() => setNotice('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {providerEdit && (
        <Modal
          title={
            data.providers.some((p) => p.id === providerEdit.id) ? '管理模型连接' : '添加模型连接'
          }
          subtitle="选择协议与认证方式，模型 ID 可按服务商文档手动填写。"
          onClose={() => !busy && setProviderEdit(null)}
          wide
        >
          <div className="modal-content">
            {providerEdit.protocol !== 'codex' && (
              <div className="preset-row">
                {presets.map((p) => (
                  <button
                    key={p.name}
                    onClick={() =>
                      setProviderEdit({ ...providerEdit, ...p, models: [...p.models], secret: '' })
                    }
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <div className="form-grid">
              <Field label="连接名称">
                <input
                  value={providerEdit.name}
                  onChange={(e) => setProviderEdit({ ...providerEdit, name: e.target.value })}
                />
              </Field>
              <Field label="接口协议">
                <select
                  value={providerEdit.protocol}
                  disabled={providerEdit.protocol === 'codex'}
                  onChange={(e) =>
                    setProviderEdit({
                      ...providerEdit,
                      protocol: e.target.value as ProviderInput['protocol'],
                    })
                  }
                >
                  {Object.entries(protocolLabels)
                    .filter(([k]) => k !== 'codex' || providerEdit.protocol === 'codex')
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
            {providerEdit.protocol === 'codex' ? (
              <div className="info-strip">
                <ShieldCheck size={18} />
                <span>在“设置与关于”中登录 ChatGPT，然后获取模型列表或手动填写模型 ID。</span>
              </div>
            ) : (
              <>
                <Field
                  label="API Base URL"
                  hint="填写协议根地址，例如 https://api.openai.com/v1；本地 HTTP 服务也受支持。"
                >
                  <input
                    placeholder="https://…/v1"
                    value={providerEdit.baseUrl}
                    onChange={(e) => setProviderEdit({ ...providerEdit, baseUrl: e.target.value })}
                  />
                </Field>
                <div className="form-grid">
                  <Field label="认证方式">
                    <select
                      value={providerEdit.auth}
                      onChange={(e) =>
                        setProviderEdit({
                          ...providerEdit,
                          auth: e.target.value as ProviderInput['auth'],
                        })
                      }
                    >
                      <option value="api-key">API Key（按协议设置请求头）</option>
                      <option value="bearer">Bearer Token</option>
                      <option value="none">无需认证（本地 / 自建）</option>
                    </select>
                  </Field>
                  <Field
                    label="API Key / Token"
                    hint={
                      providerEdit.hasSecret
                        ? '已有密钥；留空保留，填写可替换。'
                        : '密钥不回传到界面。'
                    }
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      disabled={providerEdit.auth === 'none'}
                      value={providerEdit.secret ?? ''}
                      placeholder={providerEdit.hasSecret ? '•••••••• 已安全保存' : '输入密钥'}
                      onChange={(e) => setProviderEdit({ ...providerEdit, secret: e.target.value })}
                    />
                  </Field>
                </div>
                {providerEdit.hasSecret && (
                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={providerEdit.clearSecret ?? false}
                      onChange={(e) =>
                        setProviderEdit({ ...providerEdit, clearSecret: e.target.checked })
                      }
                    />
                    清除已保存的密钥
                  </label>
                )}
              </>
            )}
            <Field label="模型列表（每行一个 ID）">
              <textarea
                rows={4}
                placeholder="模型 ID，以服务商实际支持为准"
                value={providerEdit.models.join('\n')}
                onChange={(e) =>
                  setProviderEdit({ ...providerEdit, models: e.target.value.split('\n') })
                }
              />
            </Field>
            <button className="text-button" disabled={busy} onClick={fetchModels}>
              <RefreshCw size={14} />
              保存连接并获取模型
            </button>
            <div className="form-grid">
              <Field label="单次最大输出 Tokens">
                <input
                  type="number"
                  min={256}
                  max={131072}
                  value={providerEdit.maxOutputTokens}
                  onChange={(e) =>
                    setProviderEdit({ ...providerEdit, maxOutputTokens: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="历史字符预算" hint="按完整轮次保留近期历史；不是精确 Token 计数。">
                <input
                  type="number"
                  min={4000}
                  max={1000000}
                  value={providerEdit.contextChars}
                  onChange={(e) =>
                    setProviderEdit({ ...providerEdit, contextChars: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
          </div>
          <div className="modal-footer">
            {providerEdit.id !== 'openai-codex' &&
              data.providers.some((p) => p.id === providerEdit.id) && (
                <button
                  className="text-button danger"
                  onClick={() =>
                    perform(async () => {
                      await api.deleteProvider(providerEdit.id);
                      setProviderEdit(null);
                      await refresh();
                    })
                  }
                >
                  <Trash2 size={15} />
                  删除连接
                </button>
              )}
            <span className="spacer" />
            <button
              className="secondary"
              disabled={busy || !providerEdit.models.filter(Boolean).length}
              onClick={() => saveProvider(true)}
            >
              保存并测试调用
            </button>
            <button className="primary" disabled={busy} onClick={() => saveProvider()}>
              {busy ? <Spinner /> : <Check size={15} />}保存连接
            </button>
          </div>
        </Modal>
      )}
      {agentEdit && (
        <Modal
          title="配置 Agent"
          subtitle="角色配置可以独立选择模型，也可以继承当前会话。"
          onClose={() => setAgentEdit(null)}
        >
          <div className="modal-content">
            <div className="form-grid">
              <Field label="名称">
                <input
                  value={agentEdit.name}
                  onChange={(e) => setAgentEdit({ ...agentEdit, name: e.target.value })}
                />
              </Field>
              <Field label="执行权限">
                <select
                  value={agentEdit.permission}
                  onChange={(e) =>
                    setAgentEdit({
                      ...agentEdit,
                      permission: e.target.value as 'ask' | 'read-only',
                    })
                  }
                >
                  <option value="read-only">只读分析</option>
                  <option value="ask">修改与命令需审批</option>
                </select>
              </Field>
            </div>
            <Field label="职责描述">
              <input
                value={agentEdit.description}
                onChange={(e) => setAgentEdit({ ...agentEdit, description: e.target.value })}
              />
            </Field>
            <Field label="角色指令">
              <textarea
                rows={5}
                value={agentEdit.instructions}
                onChange={(e) => setAgentEdit({ ...agentEdit, instructions: e.target.value })}
              />
            </Field>
            <div className="form-grid">
              <Field label="模型连接">
                <select
                  value={agentEdit.providerId}
                  onChange={(e) => setAgentEdit({ ...agentEdit, providerId: e.target.value })}
                >
                  <option value="">继承会话连接</option>
                  {data.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="模型 ID">
                <input
                  placeholder="留空继承会话模型"
                  value={agentEdit.model}
                  onChange={(e) => setAgentEdit({ ...agentEdit, model: e.target.value })}
                />
              </Field>
            </div>
            <Field label="最大模型轮次（直接 API 模式）">
              <input
                type="number"
                min={1}
                max={40}
                value={agentEdit.maxSteps}
                onChange={(e) => setAgentEdit({ ...agentEdit, maxSteps: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="modal-footer">
            {!['builder', 'reviewer', 'architect'].includes(agentEdit.id) &&
              data.agents.some((a) => a.id === agentEdit.id) && (
                <button
                  className="text-button danger"
                  onClick={() =>
                    perform(async () => {
                      await api.deleteAgent(agentEdit.id);
                      setAgentEdit(null);
                      await refresh();
                    })
                  }
                >
                  <Trash2 size={14} />
                  删除
                </button>
              )}
            <span className="spacer" />
            <button
              className="primary"
              onClick={() =>
                perform(async () => {
                  await api.saveAgent(agentEdit);
                  setAgentEdit(null);
                  await refresh();
                })
              }
            >
              保存 Agent
              <Check size={15} />
            </button>
          </div>
        </Modal>
      )}
      {teamOpen && (
        <Modal
          title="邀请伙伴，一起分析"
          subtitle="最多选择 3 位 Agent，独立只读分析后将结论汇回当前会话。"
          onClose={() => setTeamOpen(false)}
        >
          <div className="modal-content team-options">
            {data.agents.map((a) => (
              <label key={a.id}>
                <input
                  type="checkbox"
                  checked={teamIds.includes(a.id)}
                  onChange={(e) =>
                    setTeamIds(
                      e.target.checked
                        ? [...teamIds, a.id].slice(0, 3)
                        : teamIds.filter((id) => id !== a.id),
                    )
                  }
                />
                <span className="mini-icon">
                  <Bot size={18} />
                </span>
                <div>
                  <strong>{a.name}</strong>
                  <p>
                    {a.model || model} ·{' '}
                    {data.providers.find((p) => p.id === a.providerId)?.name || provider?.name}
                  </p>
                </div>
                <span className="tag">只读</span>
              </label>
            ))}
          </div>
          <div className="modal-footer">
            <span className="muted">每位 Agent 独立产生模型用量</span>
            <span className="spacer" />
            <button
              className="primary"
              disabled={!teamIds.length || busy}
              onClick={() => send(true)}
            >
              <Users size={16} />
              开始协作
            </button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal
          title="导入 CC Switch"
          subtitle="原始配置保持不变，请确认需要导入的连接。"
          onClose={() => setPreview(null)}
        >
          <div className="modal-content">
            {preview.providers.map((p) => (
              <div className="import-row" key={p.id}>
                <CheckCircle2 size={17} />
                <div>
                  <strong>{p.name}</strong>
                  <p>{p.baseUrl}</p>
                </div>
                <span className="tag">{p.hasSecret ? '包含密钥' : '需配置密钥'}</span>
              </div>
            ))}
            {preview.warnings.map((w, i) => (
              <p className="footnote" key={i}>
                {w}
              </p>
            ))}
          </div>
          <div className="modal-footer">
            <span className="spacer" />
            <button
              className="primary"
              disabled={!preview.providers.length || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  for (const p of preview.providers) await api.saveProvider(p);
                  setPreview(null);
                  await refresh();
                  setNotice('导入完成');
                } catch (e) {
                  report(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              导入 {preview.providers.length} 个连接
              <ArrowRight size={15} />
            </button>
          </div>
        </Modal>
      )}
      {rename !== null && (
        <Modal title="重命名会话" onClose={() => setRename(null)}>
          <div className="modal-content">
            <Field label="会话名称">
              <input autoFocus value={rename} onChange={(e) => setRename(e.target.value)} />
            </Field>
          </div>
          <div className="modal-footer">
            <button
              className="primary"
              onClick={() =>
                perform(async () => {
                  await api.updateSession(sessionId, { title: rename });
                  setRename(null);
                  await refresh();
                })
              }
            >
              保存
            </button>
          </div>
        </Modal>
      )}
      {fileView && (
        <Modal title={fileView.path} subtitle="只读文件预览" onClose={() => setFileView(null)} wide>
          <pre className="file-preview">{fileView.content}</pre>
        </Modal>
      )}
      {data.approvals.length > 0 && (
        <Modal
          title={data.approvals[0].title}
          subtitle={`来自：${data.sessions.find((s) => s.id === data.approvals[0].sessionId)?.title ?? '任务'}。仅批准本次操作。`}
          onClose={() => perform(() => api.approve(data.approvals[0].id, false))}
          wide
        >
          <pre className="approval-detail">{data.approvals[0].detail}</pre>
          <div className="modal-footer">
            <span className="muted">
              {data.approvals.length > 1 ? `还有 ${data.approvals.length - 1} 项等待审批` : ''}
            </span>
            <span className="spacer" />
            <button
              className="secondary"
              onClick={() => perform(() => api.approve(data.approvals[0].id, false))}
            >
              拒绝
            </button>
            <button
              className="primary"
              onClick={() => perform(() => api.approve(data.approvals[0].id, true))}
            >
              <Check size={16} />
              批准本次
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
