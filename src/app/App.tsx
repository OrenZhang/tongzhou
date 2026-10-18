import { providerLabel } from '../shared/provider-label';
import { t as tr, getLocale, localize as localized } from '../shared/i18n';
import { flushCanvasDraft } from '../features/canvas/draft-sync';
import { CanvasWorkspace } from '../features/canvas/CanvasWorkspace';
import { SidebarNavGroup } from '../components/SidebarNavGroup';
import { ServiceIcon, providerService } from '../components/ServiceIcon';
import { useNavigation } from './useNavigation';
import { protocolLabels } from '../features/connections/provider-presets';
import { AccountLoginPanel } from '../features/connections/AccountLoginPanel';
import { ProviderConnectionDialog } from '../features/connections/ProviderConnectionDialog';
import {
  automaticModel,
  modelStages as raw_modelStages,
  type ModelStage,
} from '../shared/model-protocol';
import type { Provider } from '../shared/types';
import { FilePreviewContext } from '../components/files/FilePreviewContext';
import { AttachmentPreview } from '../components/files/Attachments';
import { AutomationCenter } from '../features/automation/AutomationCenter';
import { KnowledgeCenter } from '../features/knowledge/KnowledgeCenter';
import { ArtifactCards, ArtifactDetail } from '../features/artifacts/Artifacts';
import { UpdateControl } from '../features/settings/UpdateControl';
import { errorMessage } from '../lib/feedback';
import { ChoicePicker } from '../components/controls/ChoicePicker';
import { TaskPanel, HistorySearch } from '../features/workspace/TaskPanel';
import { TerminalDock } from '../features/workspace/TerminalDock';
import { WorkspacePanel } from '../features/workspace/WorkspacePanel';
import { WorkspaceFileContext } from '../features/workspace/WorkspaceFileContext';
import { SessionTitle } from '../features/chat/SessionTitle';
import { useTaskContext, useWorkspaceLayout } from '../features/workspace/workspace-state';
import { DataMaintenance } from '../features/settings/DataMaintenance';
import { PowerSettings } from '../features/settings/PowerSettings';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApplicationState } from '../hooks/useApplicationState';
import { useAccountState } from '../features/connections/useAccountState';
import { useSessionMessages } from '../features/chat/useSessionMessages';
import { AgentsPage } from '../features/agents/AgentsPage';
import {
  Clock3,
  Activity,
  BookOpen,
  Image as ImageIcon,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Cpu,
  Folder,
  FolderOpen,
  GitBranch,
  Layers3,
  LayoutPanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  Network,
  Plus,
  Paperclip,
  Puzzle,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import type {
  Attachment,
  CodexLoginMethod,
  ImportPreview,
  ProviderInput,
  Session,
} from '../shared/types';
import { Extensions } from '../features/plugins/Extensions';
import { version } from '../../package.json';
import { CommandPalette } from '../components/controls/CommandPalette';
import { PendingInputs, useRunEvents } from '../features/chat/RunActivity';
import { ConversationTurn } from '../features/chat/ConversationTurn';
import { ApprovalQueue } from '../features/chat/ApprovalQueue';
import { conversationTurns, editableTurnPrompt } from '../shared/turns';
import { providerUnavailableReason } from '../shared/provider-availability';
import { InputModePicker, inputModes } from '../features/chat/InputModePicker';
import { SessionNavigator } from '../features/chat/SessionNavigator';
import { GlobalPermission, SessionPermission } from '../features/chat/PermissionControls';
import { effectivePermission } from '../shared/permissions';
import { ConnectionsPage } from '../features/connections/ConnectionsPage';
import { NetworkProfilesPanel } from '../features/connections/NetworkProfilesPanel';
import { Appearance, useAppearance } from '../features/settings/Appearance';
import { useLocale } from '../hooks/useLocale';
import { useDraft } from '../hooks/useDraft';
import { useComposerDrop } from '../features/chat/useComposerDrop';
import { AttachmentCards, useAttachmentDraft } from '../components/files/Attachments';
import { longPaste } from '../shared/attachments';
import { useConversationFollow } from '../hooks/useConversationFollow';
import { SessionNotification } from '../features/chat/NotificationControls';
import { AuthBadge, Mark, Modal, Spinner, ModelPicker } from '../components/components';

export default function App() {
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasTarget, setCanvasTarget] = useState<string>();
  const [activityTab, setActivityTab] = useState<'runs' | 'review'>('runs');
  const [reviewSession, setReviewSession] = useState('');
  const [reviewRun, setReviewRun] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [fileRequest, setFileRequest] = useState<{
    sessionId: string;
    path: string;
    line: number;
    key: number;
  }>();
  const api = window.tongzhou;
  const {
    view,
    setView,
    knowledgeTarget,
    setKnowledgeTarget,
    knowledgeSection,
    setKnowledgeSection,
    sidebarOpen,
    setSidebarOpen,
    paletteOpen,
    setPaletteOpen,
  } = useNavigation(api);
  useEffect(() => {
    if (view !== 'canvas') setCanvasTarget(undefined);
  }, [view]);
  const showSessionSidebar = view === 'workspace' && sidebarOpen;
  const { data, loaded, refresh, notice, setNotice, report, perform } = useApplicationState(api);
  const restoredSession = useRef(false);
  const [attachmentPreview, setAttachmentPreview] = useState<Attachment>();
  const [artifactId, setArtifactId] = useState<string>();
  const [artifactOrganizing, setArtifactOrganizing] = useState(false);
  const [artifactSession, setArtifactSession] = useState<string>();
  const [artifactRevision, setArtifactRevision] = useState(0);
  const [providerQuery, setProviderQuery] = useState('');
  const [runQuery, setRunQuery] = useState('');
  const [runFilter, setRunFilter] = useState('all');
  const {
    accountStates,
    authProviderId,
    setAuthProviderId,
    authPanel,
    setAuthPanel,
    codex,
    setCodex,
    nativeAccounts,
    setNativeAccounts,
    nativeRegions,
    setNativeRegions,
    authPending,
  } = useAccountState(api, data.providers, view, report, setNotice);
  const [sessionId, setSessionId] = useState('');
  const { messages, setMessages, hasEarlier, setHasEarlier, sessionRef } = useSessionMessages(
    api,
    sessionId,
    report,
  );
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [routingStage, setRoutingStage] = useState<ModelStage | ''>('');
  const [agentId, setAgentId] = useState('');
  const [inputMode, setInputMode] = useState<'supplement' | 'next' | 'restart'>('supplement');
  const [deleteId, setDeleteId] = useState('');
  const [deleteProjectId, setDeleteProjectId] = useState('');
  const [deleteProjectError, setDeleteProjectError] = useState('');
  const [deleteProjectSessions, setDeleteProjectSessions] = useState<string[]>();
  const [deleteProjectAcknowledged, setDeleteProjectAcknowledged] = useState(false);
  const { draft, setDraft, clearDraft, setSessionDraft } = useDraft(sessionId);
  const attachments = useAttachmentDraft(sessionId, (error) => report(error));
  const attachmentPicker = useRef<HTMLInputElement>(null);
  const { appearance, setAppearance } = useAppearance();
  useLocale();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [providerEdit, setProviderEdit] = useState<ProviderInput | null>(null);
  const [providerToggles, setProviderToggles] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const startLogin = (method: CodexLoginMethod) =>
    perform(async () => setCodex(await api.codexLogin(method, authProviderId)));
  const feed = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const outside = (event: Event) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('.composer-model-menu,.choice-panel,.model-picker-panel')
      ) {
        const menu = document.querySelector<HTMLDetailsElement>('.composer-model-menu');
        if (menu) menu.open = false;
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, []);
  useEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(200, input.scrollHeight)}px`;
  }, [draft, view]);
  const session = data.sessions.find((s) => s.id === sessionId);
  const composerDrop = useComposerDrop({
    api,
    input: composerInput,
    setDraft,
    addFiles: attachments.addFiles,
    disabled: !!session?.archived,
    sessionId,
    report,
  });
  const project = data.projects.find((p) => p.id === session?.projectId);
  const provider = data.providers.find((p) => p.id === providerId);
  const poolReady = (p: Provider) =>
    p.enabled !== false &&
    p.modelPool?.some((entry) => {
      const target = data.providers.find((v) => v.id === entry.providerId);
      return (
        target &&
        target.models.includes(entry.model) &&
        !providerUnavailableReason(target, accountStates[target.id])
      );
    });
  const availableProviders = data.providers.filter(
    (p) => !providerUnavailableReason(p, accountStates[p.id]) || poolReady(p),
  );
  const firstModel = (p: Provider) =>
    providerUnavailableReason(p, accountStates[p.id]) || !p.models[0]
      ? p.modelPool?.length
        ? automaticModel
        : ''
      : p.models[0];
  const unavailableReason = provider
    ? model === automaticModel && poolReady(provider)
      ? ''
      : providerUnavailableReason(provider, accountStates[provider.id])
    : tr('请选择连接');
  const providerReady = !!provider && !unavailableReason;
  const selectedAgent = data.agents.find((a) => a.id === agentId);
  const sessionPermission = effectivePermission(session, data.defaultPermission, selectedAgent);
  const running = data.runs.find((r) => r.sessionId === sessionId && r.status === 'running');
  const [workspace, updateWorkspace] = useWorkspaceLayout(sessionId);
  const taskContext = useTaskContext(
    api,
    sessionId,
    project?.id,
    data.runs
      .filter((r) => r.sessionId === sessionId)
      .map((r) => `${r.id}:${r.status}`)
      .join(','),
    view === 'workspace',
  );
  const openReview = (
    runId = taskContext.task?.runs[0]?.id ?? '',
    reviewTab: 'changes' | 'evidence' = 'changes',
  ) => {
    setArtifactId(undefined);
    setAttachmentPreview(undefined);
    updateWorkspace({ open: true, tab: 'review', scope: 'task', runId, reviewTab });
  };
  const openTerminal = () => {
    if (!session || session.knowledgeJob) return;
    setArtifactId(undefined);
    setAttachmentPreview(undefined);
    const target = session;
    void perform(async () => {
      const task = await api.taskState(target.id);
      const saved = localStorage.getItem(`tongzhou-terminal-${target.id}`);
      const terminal =
        task.terminals.find((t) => t.id === saved) ??
        task.terminals.find((t) => t.status === 'running') ??
        task.terminals.at(-1) ??
        (target.archived ? undefined : await api.startTerminal(target.id));
      updateWorkspace({
        open: workspace.dock === 'right' || workspace.open,
        tab: 'terminal',
        terminalOpen: true,
        terminalId: terminal?.id ?? '',
      });
    });
  };
  const activity = useRunEvents(api, sessionId);
  const turns = useMemo(
    () => conversationTurns(sessionId, messages, data.runs, activity.events),
    [sessionId, messages, data.runs, activity.events],
  );
  const conversationFollow = useConversationFollow(feed, sessionId, view === 'workspace', turns);
  const activateSession = (selected: Session) => {
    setArtifactId(undefined);
    setAttachmentPreview(undefined);
    localStorage.setItem('tongzhou-last-session', selected.id);
    sessionRef.current = selected.id;
    setSessionId(selected.id);
    setInputMode('supplement');
    setProviderId(selected.providerId);
    setModel(selected.model);
    setRoutingStage('');
    setAgentId(data.agents.some((a) => a.id === selected.agentId) ? selected.agentId : '');
    setView('workspace');
  };
  useEffect(() => {
    if (!loaded || restoredSession.current) return;
    restoredSession.current = true;
    if (sessionRef.current) return;
    const saved = localStorage.getItem('tongzhou-last-session');
    const previous = data.sessions.find((s) => s.id === saved && !s.archived && !s.parentId);
    if (previous) activateSession(previous);
    else if (saved) localStorage.removeItem('tongzhou-last-session');
  }, [loaded, data.sessions]);
  useEffect(() => {
    if (!sessionRef.current && !sessionId && !providerId && availableProviders.length) {
      setProviderId(availableProviders[0].id);
      setModel(firstModel(availableProviders[0]));
    }
  }, [sessionId, providerId, availableProviders]);
  useEffect(() => {
    if (!model && provider?.models[0]) setModel(provider.models[0]);
  }, [model, provider?.models]);
  const newSession = async (projectId?: string) => {
    await perform(async () => {
      const s = await api.createSession(projectId);
      const preferred = providerReady ? provider : availableProviders[0];
      activateSession({
        ...s,
        providerId: preferred?.id ?? '',
        model: preferred?.id === providerId ? model : preferred ? firstModel(preferred) : '',
        agentId: '',
      });
      if (preferred)
        await api.updateSession(s.id, {
          providerId: preferred.id,
          model: preferred.id === providerId ? model : firstModel(preferred),
        });
      await refresh();
    });
  };
  const openProject = () =>
    perform(async () => {
      const p = await api.addProject();
      if (p) await newSession(p.id);
    });
  const send = async (team = false) => {
    if (
      busy ||
      attachments.pending ||
      session?.archived ||
      (!draft.trim() && !attachments.items.length) ||
      !model.trim() ||
      !providerId
    )
      return;
    if (!running && !providerReady) return;
    setBusy(true);
    try {
      let targetId = sessionId;
      if (!targetId) {
        const created = await api.createSession();
        targetId = created.id;
        attachments.copyTo(targetId);
        attachments.clear(sessionId, attachments.items);
        activateSession({ ...created, providerId, model, agentId });
      }
      await flushCanvasDraft(targetId, api);
      const input = {
        ...(model === automaticModel && routingStage ? { routingStage } : {}),
        sessionId: targetId,
        prompt: draft,
        providerId,
        model,
        agentId,
        attachmentIds: attachments.items.map((a) => a.id),
      };
      if (running) await api.enqueue(input, inputMode);
      else if (team) await api.team(input, teamIds);
      else await api.run(input);
      clearDraft(sessionId, draft);
      attachments.clear(sessionId, attachments.items);
      if (targetId !== sessionId) attachments.clear(targetId, attachments.items);
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
      contextChars: 0,
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
        setNotice(tr('连接已保存'));
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
      setNotice(tr('已获取并保存 {0} 个模型', [models.length]));
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const navGroups = [
    {
      label: tr('资源与工具'),
      items: [
        { id: 'agents', label: 'Agent', icon: Users },
        { id: 'knowledge', label: tr('智库'), icon: BookOpen },
        { id: 'canvas', label: tr('创作'), icon: Layers3 },
        { id: 'connections', label: tr('渠道'), icon: Network },
        { id: 'extensions', label: tr('插件'), icon: Puzzle },
        { id: 'providers', label: tr('模型'), icon: Cpu },
      ],
    },
    {
      label: tr('任务与记录'),
      items: [
        { id: 'activity', label: tr('运行记录'), icon: Activity },
        { id: 'automations', label: tr('定时任务'), icon: Clock3 },
      ],
    },
  ] as const;
  const nav = navGroups.flatMap((group) => [...group.items]);
  const selectModel = (connection: string, selectedModel: string) => {
    setProviderId(connection);
    setModel(selectedModel);
    setRoutingStage('');
    if (sessionId)
      void perform(() =>
        api.updateSession(sessionId, { providerId: connection, model: selectedModel }),
      );
  };
  const statusLabel = (s: string) =>
    ({
      running: tr('运行中'),
      completed: tr('已完成'),
      interrupted: tr('已停止'),
      failed: tr('失败'),
    })[s] ?? s;

  if (!api)
    return (
      <div className="browser-fallback">
        <Mark />
        <h1>CoSail</h1>
        <p>
          {tr('请使用桌面应用打开。开发模式运行 ')}
          <code>npm run dev</code>。
        </p>
      </div>
    );
  return (
    <FilePreviewContext.Provider
      value={(file) => {
        setArtifactId(undefined);
        setAttachmentPreview(file);
      }}
    >
      <div
        className={`app-shell ${showSessionSidebar ? '' : 'sidebar-collapsed'}`}
        data-view={view}
      >
        <aside className="sidebar" aria-label={tr('主导航')}>
          <nav className="sidebar-rail" aria-label={tr('管理与工具')}>
            <button
              className="rail-button"
              hidden={view !== 'workspace'}
              aria-label={sidebarOpen ? tr('收起会话列表') : tr('展开会话列表')}
              aria-expanded={sidebarOpen}
              aria-controls="sidebar-sessions"
              onClick={() => setSidebarOpen((open) => !open)}
            >
              {sidebarOpen ? (
                <PanelLeftClose size={19} aria-hidden="true" />
              ) : (
                <PanelLeftOpen size={19} aria-hidden="true" />
              )}
              <span className="rail-tooltip" aria-hidden="true">
                {sidebarOpen ? tr('收起会话列表') : tr('展开会话列表')}
              </span>
            </button>
            <button
              className={`rail-button ${view === 'workspace' ? 'active' : ''}`}
              aria-label={tr('会话')}
              aria-current={view === 'workspace' ? 'page' : undefined}
              onClick={() => {
                setView('workspace');
              }}
            >
              <MessageSquare size={19} aria-hidden="true" />
              <span className="rail-tooltip" aria-hidden="true">
                {tr('会话')}
              </span>
            </button>
            {navGroups.map((group) => (
              <SidebarNavGroup
                key={group.label}
                label={group.label}
                items={group.items}
                view={view}
                onNavigate={(nextView) => {
                  if (nextView === 'canvas') setCanvasTarget(undefined);
                  if (nextView === 'knowledge') {
                    setKnowledgeSection('workspace');
                    setArtifactSession(undefined);
                  }
                  setView(nextView);
                }}
              />
            ))}
            <div className="rail-footer">
              <UpdateControl api={api} />
              <button
                aria-label={tr('设置')}
                onClick={() => setView('settings')}
                aria-current={['settings', 'network'].includes(view) ? 'page' : undefined}
                className={`rail-button ${['settings', 'network'].includes(view) ? 'active' : ''}`}
              >
                <Settings2 size={19} aria-hidden="true" />
                <span className="rail-tooltip" aria-hidden="true">
                  {tr('设置')}
                </span>
              </button>
            </div>
          </nav>
          <div
            id="sidebar-sessions"
            className="sidebar-sessions"
            inert={!showSessionSidebar}
            hidden={!showSessionSidebar}
          >
            <button
              className="brand"
              aria-label={tr('返回会话')}
              title={tr('返回当前会话')}
              onClick={() => setView('workspace')}
            >
              <Mark />
              <div>
                <strong>CoSail</strong>
                <span>TONGZHOU</span>
              </div>
              <span className="version">{version}</span>
            </button>
            <button className="new-chat" onClick={() => newSession()}>
              <Plus size={17} />
              {tr('开启新会话')}
              <span>↗</span>
            </button>
            <div className="sidebar-divider" />
            <SessionNavigator
              data={data}
              sessionId={sessionId}
              workspace={view === 'workspace'}
              archived={archived}
              query={query}
              onArchive={() => setArchived(!archived)}
              onQuery={setQuery}
              onOpenProject={openProject}
              onNew={(id) => void newSession(id)}
              onSelect={activateSession}
              onToggleArchive={(target) =>
                void perform(() => api.updateSession(target.id, { archived: !target.archived }))
              }
              onDelete={(target) => target.archived && setDeleteId(target.id)}
              onDeleteProject={(target) => {
                setNotice('');
                setDeleteProjectId(target.id);
                setDeleteProjectError('');
                setDeleteProjectSessions(undefined);
                setDeleteProjectAcknowledged(false);
                void api
                  .projectDeletionPreview(target.id)
                  .then(setDeleteProjectSessions)
                  .catch((e) => setDeleteProjectError(errorMessage(e)));
              }}
            />
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <nav className="breadcrumb" aria-label={tr('面包屑导航')}>
              <button
                className="icon-button"
                hidden={view !== 'workspace'}
                aria-label={sidebarOpen ? tr('收起导航') : tr('展开导航')}
                title={tr('切换导航（Ctrl / ⌘ B）')}
                aria-expanded={sidebarOpen}
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <LayoutPanelLeft size={17} />
              </button>
              <button className="breadcrumb-link" onClick={() => setView('workspace')}>
                CoSail
              </button>
              <ChevronRight size={13} aria-hidden="true" />
              {view === 'network' && (
                <>
                  <button className="breadcrumb-link" onClick={() => setView('settings')}>
                    {tr('设置')}
                  </button>
                  <ChevronRight size={13} aria-hidden="true" />
                </>
              )}
              <strong aria-current="page">
                {view === 'workspace'
                  ? (project?.name ?? (session ? tr('会话') : tr('新会话')))
                  : {
                      providers: tr('模型'),
                      connections: tr('渠道'),
                      network: tr('网络配置'),
                      agents: 'Agent',
                      activity: tr('运行记录'),
                      settings: tr('设置'),
                      extensions: tr('插件'),
                      knowledge: tr('智库'),
                      canvas: tr('创作'),
                      automations: tr('定时任务'),
                    }[view]}
              </strong>
            </nav>
            <div className="topbar-right">
              {data.approvals.some((a) => view !== 'workspace' || a.sessionId !== sessionId) && (
                <button
                  className="approval-notice"
                  onClick={() => {
                    const approval = data.approvals.find(
                      (a) => view !== 'workspace' || a.sessionId !== sessionId,
                    );
                    const target = data.sessions.find((s) => s.id === approval?.sessionId);
                    if (target) activateSession(target);
                  }}
                >
                  {tr('待处理 ·')}{' '}
                  {
                    data.approvals.filter((a) => view !== 'workspace' || a.sessionId !== sessionId)
                      .length
                  }
                </button>
              )}
              {view === 'workspace' && session && (
                <button
                  className="icon-button"
                  aria-label={tr('会话作品')}
                  title={tr('查看当前会话生成的作品')}
                  onClick={() => {
                    setArtifactSession(session.id);
                    setKnowledgeSection('artifacts');
                    setView('knowledge');
                  }}
                >
                  <ImageIcon size={17} />
                </button>
              )}
              <button
                className="quick-search-trigger"
                aria-label={tr('搜索与快捷操作')}
                onClick={() => setPaletteOpen(true)}
              >
                <Search size={15} />
                <span>{tr('搜索与快捷操作')}</span>
                <kbd>{navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K'}</kbd>
              </button>
              {view === 'workspace' && session && (
                <button
                  className={
                    'workspace-entry secondary ' +
                    (workspace.open || artifactId || attachmentPreview ? 'active' : '')
                  }
                  aria-label={
                    workspace.open || artifactId || attachmentPreview
                      ? tr('收起工作区')
                      : tr('展开工作区')
                  }
                  aria-expanded={workspace.open || !!artifactId || !!attachmentPreview}
                  title={tr('文件、审阅与终端')}
                  onClick={() => {
                    const open = workspace.open || !!artifactId || !!attachmentPreview;
                    setArtifactId(undefined);
                    setAttachmentPreview(undefined);
                    updateWorkspace({ open: !open });
                  }}
                >
                  <LayoutPanelLeft size={16} />
                  {tr(' 工作区')}
                </button>
              )}
              <span className="local-badge">
                <ShieldCheck size={13} />
                {tr('本地存储')}
              </span>
            </div>
          </header>
          {view === 'workspace' && (
            <div
              className={`workspace-layout ${canvasOpen && session ? 'has-canvas' : workspace.open && session ? 'has-context' : ''}`}
            >
              <main className="conversation">
                {session && (
                  <div className="conversation-header">
                    <div>
                      <SessionTitle
                        key={session.id}
                        title={session.title}
                        onSave={async (title) => {
                          await api.updateSession(session.id, { title });
                          await refresh();
                        }}
                      />
                    </div>
                    <div className="row">
                      <button
                        className="terminal-entry"
                        onClick={() => openReview()}
                        title={tr('在当前会话中审阅改动')}
                      >
                        <GitBranch size={16} />
                        {tr(' 审阅')}
                      </button>
                      <button
                        className="terminal-entry"
                        aria-expanded={
                          workspace.terminalOpen &&
                          (workspace.dock === 'bottom' ||
                            (workspace.open && workspace.tab === 'terminal'))
                        }
                        disabled={busy || !!session.knowledgeJob}
                        title={tr('打开本会话终端')}
                        onClick={openTerminal}
                      >
                        <Terminal size={16} />
                        {tr(' 终端')}
                      </button>
                      <button
                        className="icon-button"
                        aria-label={tr('搜索消息内容')}
                        title={tr('搜索消息内容')}
                        onClick={() => setHistoryOpen(true)}
                      >
                        <Search size={16} />
                      </button>
                      {!session.archived && (
                        <SessionNotification
                          session={session}
                          run={running}
                          data={data}
                          api={api}
                          onError={report}
                        />
                      )}
                      <button
                        className="icon-button"
                        aria-label={tr('导出会话')}
                        title={tr('导出 Markdown')}
                        onClick={() =>
                          perform(async () => {
                            const f = await api.exportSession(sessionId);
                            if (f) setNotice(tr('会话已导出'));
                          })
                        }
                      >
                        <ArrowDownToLine size={16} />
                      </button>
                    </div>
                  </div>
                )}
                <div
                  className={'feed ' + (!turns.length ? 'empty-feed' : '')}
                  ref={feed}
                  tabIndex={0}
                  aria-label={tr('会话内容')}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !e.altKey) {
                      const selection = window.getSelection();
                      if (
                        selection?.toString() &&
                        selection.anchorNode &&
                        feed.current?.contains(selection.anchorNode)
                      ) {
                        e.preventDefault();
                        void api.copyText(selection.toString()).catch(report);
                      }
                    }
                  }}
                >
                  {hasEarlier && (
                    <button
                      className="secondary"
                      onClick={() =>
                        perform(async () => {
                          const result = await api.messages(sessionId, { before: messages[0]?.id });
                          if (sessionRef.current !== sessionId) return;
                          const height = feed.current?.scrollHeight ?? 0;
                          setMessages((old) => [
                            ...result,
                            ...old.filter((m) => !result.some((r) => r.id === m.id)),
                          ]);
                          setHasEarlier(result.length === 100);
                          requestAnimationFrame(() => {
                            if (feed.current)
                              feed.current.scrollTop = feed.current.scrollHeight - height;
                          });
                        })
                      }
                    >
                      {tr('加载更早消息')}
                    </button>
                  )}
                  {!turns.length ? (
                    <div className="welcome">
                      <div className="welcome-mark">
                        <Mark />
                      </div>
                      <h1>{project ? tr('从这个项目，开始。') : tr('今天，一起做点什么？')}</h1>
                      <p>
                        {project
                          ? tr('读代码、改功能、验证结果，同一个会话里完成。')
                          : tr('随时聊天、解决问题，或打开项目一起创作。')}
                      </p>
                      <div className="welcome-actions">
                        {!project && (
                          <button className="primary open-project" onClick={openProject}>
                            <FolderOpen size={18} />
                            {tr('打开项目')}
                            <ArrowRight size={15} />
                          </button>
                        )}
                        <button className="text-button" onClick={() => setView('providers')}>
                          {tr('连接模型')}
                          <ArrowRight size={14} />
                        </button>
                      </div>
                      <div className="prompt-grid">
                        {(project
                          ? [
                              {
                                icon: Code2,
                                title: tr('读懂一个项目'),
                                text: tr('分析这个项目的结构、核心模块和运行方式。'),
                              },
                              {
                                icon: GitBranch,
                                title: tr('一起规划实现'),
                                text: tr('阅读项目，提出下一阶段最值得实现的功能与具体步骤。'),
                              },
                              {
                                icon: ShieldCheck,
                                title: tr('发现潜在问题'),
                                text: tr('审查项目中的代码，找出有证据的缺陷和测试缺口。'),
                              },
                            ]
                          : [
                              {
                                icon: MessageSquare,
                                title: tr('聊一个问题'),
                                text: tr('帮我用通俗的语言解释大语言模型是如何工作的。'),
                              },
                              {
                                icon: Sparkles,
                                title: tr('一起想点子'),
                                text: tr('我想做一个个人开源项目，帮我梳理方向和第一步。'),
                              },
                              {
                                icon: Code2,
                                title: tr('学习与写作'),
                                text: tr('帮我设计一个循序渐进的编程学习计划。'),
                              },
                            ]
                        ).map((p) => (
                          <button
                            key={p.title}
                            onClick={() => {
                              setDraft(p.text);
                              composerInput.current?.focus();
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
                        {availableProviders.length}
                        {tr(' 个可用连接')}
                        <span>·</span>
                        <Bot size={14} />
                        {data.agents.length}
                        {tr(' 个 Agent')}
                        <span>·</span>
                        {tr('上下文随任务同行')}
                      </div>
                    </div>
                  ) : (
                    <WorkspaceFileContext.Provider
                      value={
                        project
                          ? {
                              root: project.path,
                              open: (path, line) => {
                                setArtifactId(undefined);
                                setAttachmentPreview(undefined);
                                setFileRequest({ sessionId, path, line, key: Date.now() });
                                updateWorkspace({ open: true, tab: 'files' });
                              },
                            }
                          : null
                      }
                    >
                      {turns.map((turn) => {
                        const changedFiles =
                          taskContext.task?.changes.find((change) => change.id === turn.runId)
                            ?.files.length ?? 0;
                        const hasEvidence =
                          !!turn.runId &&
                          !!taskContext.task?.evidence.some(
                            (record) => record.runId === turn.runId,
                          );
                        return (
                          <ConversationTurn
                            key={turn.key}
                            turn={turn}
                            editableMessageId={
                              !running && !session?.archived && turn === turns.at(-1)
                                ? editableTurnPrompt(turn)?.id
                                : undefined
                            }
                            resendDisabled={busy || !providerReady || !model.trim() || !providerId}
                            onResend={async (message, text) => {
                              setBusy(true);
                              try {
                                await flushCanvasDraft(sessionId, api);
                                await api.resendMessage(message.id, {
                                  ...(model === automaticModel && routingStage
                                    ? { routingStage }
                                    : {}),
                                  sessionId,
                                  prompt: text,
                                  providerId,
                                  model,
                                  agentId,
                                  attachmentIds: message.attachments?.map((a) => a.id),
                                });
                                await refresh();
                              } catch (error) {
                                report(error);
                                throw error;
                              } finally {
                                setBusy(false);
                              }
                            }}
                            artifacts={
                              <ArtifactCards
                                key={artifactRevision}
                                ids={turn.messages.flatMap((m) => m.artifactIds ?? [])}
                                onOpen={(id) => {
                                  setAttachmentPreview(undefined);
                                  setArtifactId(id);
                                }}
                              />
                            }
                            branchDisabled={!!running}
                            delivery={
                              turn.run && turn.run.status !== 'running' && changedFiles > 0 ? (
                                <div className="turn-delivery" aria-label={tr('任务交付')}>
                                  <strong>
                                    {turn.run.status === 'completed'
                                      ? tr('执行已结束')
                                      : turn.run.status === 'failed'
                                        ? tr('执行失败')
                                        : tr('执行已中断')}
                                  </strong>
                                  {changedFiles > 0 && (
                                    <span>
                                      {changedFiles}
                                      {tr(' 个文件发生变化')}
                                    </span>
                                  )}
                                  {changedFiles > 0 && (
                                    <button onClick={() => openReview(turn.runId)}>
                                      {tr('查看改动')}
                                    </button>
                                  )}
                                  {hasEvidence && (
                                    <button onClick={() => openReview(turn.runId, 'evidence')}>
                                      {tr('验证记录')}
                                    </button>
                                  )}
                                </div>
                              ) : undefined
                            }
                            onAgentControl={(threadId, action) =>
                              api.controlAgent(sessionId, threadId, action)
                            }
                            onCopy={(message) =>
                              void perform(async () => {
                                await api.copyText(message.content);
                                setNotice(tr('已复制'));
                              })
                            }
                            onQuote={(message) => {
                              setDraft((text) =>
                                tr('{0}{1}针对历史消息（{2}）补充：\n> {3}\n\n', [
                                  text,
                                  text ? '\n\n' : '',
                                  message.id,
                                  message.content.slice(0, 1500).replace(/\n/g, '\n> '),
                                ]),
                              );
                              composerInput.current?.focus();
                            }}
                            onBranch={(message) =>
                              void perform(async () => {
                                const branch = await api.branchSession(sessionId, message.id);
                                await refresh();
                                activateSession(branch);
                              })
                            }
                          />
                        );
                      })}
                    </WorkspaceFileContext.Provider>
                  )}
                </div>
                <div className="composer-wrap">
                  <ApprovalQueue
                    approvals={data.approvals.filter((a) => a.sessionId === sessionId)}
                    onAnswer={async (id, answers) => {
                      await api.answerQuestions(id, answers);
                      await refresh();
                    }}
                    onDecide={async (id, allow) => {
                      await api.approve(id, allow);
                      await refresh();
                    }}
                  />
                  {!conversationFollow.following && turns.length > 0 && (
                    <button
                      className="follow-latest secondary"
                      onClick={conversationFollow.resume}
                      title={tr('回到最新消息并继续跟随')}
                    >
                      <ArrowDownToLine size={14} />
                      {tr(' 回到最新')}
                    </button>
                  )}
                  {activity.error && (
                    <p role="alert">
                      {tr('处理记录加载失败：')}
                      {activity.error}
                    </p>
                  )}
                  {activity.hasEarlier && (
                    <button
                      className="text-button"
                      disabled={activity.loadingEarlier}
                      onClick={() => void activity.loadEarlier()}
                    >
                      {tr('加载更早处理记录')}
                    </button>
                  )}
                  <PendingInputs key={sessionId} api={api} sessionId={sessionId} data={data} />
                  {session && (
                    <div className="composer-context" aria-label={tr('执行上下文')}>
                      <button
                        className="context-chip"
                        title={project?.path ?? taskContext.task?.cwd ?? tr('正在读取执行目录')}
                        onClick={() => updateWorkspace({ open: true, tab: 'files' })}
                      >
                        <Folder size={13} />
                        <span>{project?.name ?? tr('会话工作目录')}</span>
                      </button>
                      <span
                        className="context-chip"
                        title={taskContext.task?.cwd ?? taskContext.error ?? tr('正在读取执行目录')}
                      >
                        <Terminal size={13} />
                        <span>
                          {taskContext.error ?? (taskContext.task ? tr('本地') : tr('读取中…'))}
                        </span>
                      </span>
                      {project && (
                        <button
                          className="context-chip"
                          title={tr('查看工作目录全部改动')}
                          onClick={() =>
                            updateWorkspace({ open: true, tab: 'review', scope: 'directory' })
                          }
                        >
                          <GitBranch size={13} />
                          <span>{taskContext.branch ?? tr('读取分支…')}</span>
                        </button>
                      )}
                      <button
                        className="context-chip"
                        onClick={() => setCanvasOpen((v) => !v)}
                        aria-expanded={canvasOpen}
                      >
                        <Layers3 size={13} />
                        {tr('创作')}
                        {session.activeCanvasId ? tr(' · 已关联') : ''}
                      </button>
                      {session && (
                        <SessionPermission
                          session={session}
                          defaultPermission={data.defaultPermission ?? 'ask'}
                          effective={sessionPermission}
                          running={running}
                          api={api}
                          onError={report}
                        />
                      )}
                    </div>
                  )}

                  {selectedAgent && (
                    <div className="selected-agent-note">
                      <Bot size={16} />
                      <div>
                        <strong>{selectedAgent.name}</strong>
                        <span>{selectedAgent.description}</span>
                      </div>
                      <button
                        className="icon-button"
                        aria-label={tr('移除专属 Agent')}
                        title={tr('移除角色')}
                        disabled={!!running}
                        onClick={() => setAgentId('')}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}
                  <div
                    {...composerDrop.handlers}
                    className={
                      'composer ' +
                      (running ? 'is-running ' : '') +
                      (composerDrop.dragging ? 'is-file-drag' : '')
                    }
                  >
                    {composerDrop.dragging && (
                      <p className="composer-drop-hint" role="status">
                        {tr('松开以插入文件路径')}
                      </p>
                    )}
                    <AttachmentCards
                      items={attachments.items}
                      onRemove={busy ? undefined : attachments.remove}
                    />
                    {attachments.pending && (
                      <p className="attachment-hint" role="status">
                        {tr('正在添加附件…')}
                      </p>
                    )}
                    <input
                      ref={attachmentPicker}
                      type="file"
                      hidden
                      multiple
                      accept="image/png,image/jpeg,image/webp,.txt,.md,.json,.csv,.log,.js,.ts,.tsx,.py,.yaml,.yml"
                      aria-label={tr('选择附件文件')}
                      onChange={(e) => {
                        void attachments.addFiles(Array.from(e.target.files ?? []));
                        e.target.value = '';
                      }}
                    />
                    <textarea
                      ref={composerInput}
                      aria-label={tr('消息')}
                      placeholder={
                        project
                          ? tr('描述你的想法，或让 Agent 接着完成任务…')
                          : tr('直接输入消息开始聊天，无需打开项目…')
                      }
                      value={draft}
                      disabled={!!session?.archived}
                      onChange={(e) => setDraft(e.target.value)}
                      onPaste={(e) => {
                        const files = Array.from(e.clipboardData.files);
                        if (files.length) {
                          e.preventDefault();
                          void attachments.addFiles(files);
                          return;
                        }
                        const text = e.clipboardData.getData('text/plain');
                        if (longPaste(text)) {
                          e.preventDefault();
                          void attachments
                            .addFiles([
                              new File([text], tr('粘贴文本-{0}.txt', [Date.now()]), {
                                type: 'text/plain',
                              }),
                            ])
                            .then((added) => {
                              if (added) setNotice(tr('长文本已转为附件，点击卡片可查看全文'));
                            });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="composer-toolbar">
                      <details
                        className="composer-model-menu"
                        onKeyDown={(event) => {
                          if (event.key === 'Escape' && !event.defaultPrevented) {
                            event.currentTarget.open = false;
                            event.currentTarget.querySelector('summary')?.focus();
                          }
                        }}
                      >
                        <summary
                          aria-label={tr('选择模型与连接')}
                          title={`${provider ? providerLabel(provider) : tr('未连接')} · ${model || tr('选择模型')}`}
                        >
                          <span>
                            {providerReady
                              ? model === automaticModel
                                ? tr('自动路由')
                                : (provider?.modelLabels?.[model] ?? model)
                              : tr('选择模型')}
                          </span>
                          <small>{provider ? providerLabel(provider) : tr('未连接')}</small>
                          <ChevronDown size={13} />
                        </summary>
                        <div className="composer-model-options">
                          <div className="composer-controls">
                            <ChoicePicker
                              label={tr('当前连接')}
                              compact
                              searchable
                              value={providerReady ? providerId : ''}
                              options={availableProviders.map((p) => ({
                                value: p.id,
                                label: providerLabel(p),
                                detail: tr('{0} 个模型', [p.models.length]),
                              }))}
                              placeholder={
                                availableProviders.length ? tr('选择连接') : tr('暂无可用连接')
                              }
                              onChange={(id) =>
                                selectModel(
                                  id,
                                  firstModel(data.providers.find((p) => p.id === id)!),
                                )
                              }
                              disabled={!!running}
                            />
                            <ModelPicker
                              key={providerId}
                              label={tr('当前模型')}
                              compact
                              value={providerReady ? model : ''}
                              models={
                                providerReady
                                  ? [
                                      ...(provider?.modelPool?.length ? [automaticModel] : []),
                                      ...(provider?.models ?? []),
                                    ]
                                  : []
                              }
                              modelLabels={{
                                ...provider?.modelLabels,
                                [automaticModel]: tr('自动路由'),
                              }}
                              load={
                                providerReady && provider
                                  ? () => api.models(provider.id)
                                  : undefined
                              }
                              onChange={(m) => selectModel(providerId, m)}
                              disabled={!!running || !providerReady}
                            />
                            {model === automaticModel && (
                              <select
                                aria-label={tr('路由阶段')}
                                value={routingStage}
                                disabled={!!running}
                                onChange={(e) => setRoutingStage(e.target.value as ModelStage | '')}
                              >
                                <option value="">{tr('自动识别阶段')}</option>
                                {Object.entries(modelStages).map(([v, label]) => (
                                  <option key={v} value={v}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>
                      </details>
                      <div className="row composer-actions">
                        <button
                          className="icon-button"
                          aria-label={tr('添加图片或文件')}
                          title={tr('添加图片或文本文件，也可直接粘贴图片')}
                          disabled={busy || attachments.pending || !!session?.archived}
                          onClick={() => attachmentPicker.current?.click()}
                        >
                          <Paperclip size={17} />
                        </button>
                        <button
                          className="icon-button"
                          title={tr('多 Agent 协作（只读分析）')}
                          aria-label={tr('多 Agent 协作')}
                          disabled={
                            !!session?.archived ||
                            (!draft.trim() && !attachments.items.length) ||
                            !!running ||
                            busy ||
                            attachments.pending ||
                            !model ||
                            !providerReady
                          }
                          onClick={() => setTeamOpen(true)}
                        >
                          <Users size={18} />
                        </button>
                        {running && (
                          <>
                            <InputModePicker
                              key={sessionId}
                              value={inputMode}
                              onChange={setInputMode}
                            />
                            <button
                              className="send-button"
                              aria-label={tr('补充')}
                              title={inputModes.find((mode) => mode.value === inputMode)?.label}
                              disabled={
                                busy ||
                                attachments.pending ||
                                (!draft.trim() && !attachments.items.length)
                              }
                              onClick={() => send()}
                            >
                              {busy ? <Spinner /> : <ArrowUp size={18} />}
                            </button>
                          </>
                        )}
                        {running ? (
                          <button
                            className="send-button stop"
                            aria-label={tr('停止执行')}
                            onClick={() => perform(() => api.cancel(sessionId))}
                          >
                            <Square size={15} fill="currentColor" />
                          </button>
                        ) : (
                          <button
                            className="send-button"
                            aria-label={tr('发送消息')}
                            disabled={
                              (!draft.trim() && !attachments.items.length) ||
                              attachments.pending ||
                              !model.trim() ||
                              !providerId ||
                              !providerReady ||
                              busy ||
                              !!session?.archived
                            }
                            onClick={() => send()}
                          >
                            {busy ? <Spinner /> : <ArrowUp size={20} />}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  {!providerReady && !running && (
                    <div className="composer-connection-notice" role="status">
                      <span>
                        {provider
                          ? `${provider.name}：${unavailableReason}`
                          : tr('先连接一个模型，即可开始聊天')}
                      </span>
                      <button className="text-button" onClick={() => setView('providers')}>
                        {tr('管理模型 ')}
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                  <div className="composer-caption">
                    <span>
                      {running ? (
                        <>
                          <span className="live-dot" />
                          {data.approvals.some((approval) => approval.sessionId === sessionId)
                            ? tr('有问题或审批需要你处理')
                            : `${running.agentName} · ${running.phase || tr('正在工作')}`}
                        </>
                      ) : (
                        <>
                          <ShieldCheck size={12} />
                          {project
                            ? tr('文件修改与命令执行受权限控制')
                            : tr('普通聊天 · 无需项目文件夹')}
                        </>
                      )}
                    </span>
                    <span>{tr('Enter 发送 · Shift + Enter 换行')}</span>
                  </div>
                </div>
                {session && workspace.terminalOpen && workspace.dock === 'bottom' && (
                  <TerminalDock
                    key={session.id}
                    api={api}
                    sessionId={session.id}
                    initialId={workspace.terminalId}
                    disabled={!!session.archived || !!session.knowledgeJob}
                    onClose={() => updateWorkspace({ terminalOpen: false })}
                    onDockRight={() =>
                      updateWorkspace({ dock: 'right', open: true, tab: 'terminal' })
                    }
                  />
                )}
              </main>
              {session && canvasOpen && (
                <CanvasWorkspace
                  key={session.id}
                  compact
                  api={api}
                  data={data}
                  sessionId={session.id}
                  onSession={activateSession}
                  onClose={() => setCanvasOpen(false)}
                />
              )}
              {session && !canvasOpen && workspace.open && !artifactId && !attachmentPreview && (
                <WorkspacePanel
                  key={session.id}
                  fileRequest={fileRequest?.sessionId === session.id ? fileRequest : undefined}
                  api={api}
                  session={session}
                  project={project}
                  running={!!running}
                  layout={workspace}
                  update={updateWorkspace}
                  onTerminal={openTerminal}
                  onNotice={setNotice}
                  onReference={(text) => {
                    setDraft((old) => (old ? old + '\n\n' + text : text));
                    setNotice(tr('已引用到当前会话输入框，可补充要求后发送'));
                    composerInput.current?.focus();
                  }}
                />
              )}
            </div>
          )}
          {view === 'canvas' && (
            <CanvasWorkspace
              initialCanvasId={canvasTarget}
              api={api}
              data={data}
              sessionId={sessionId}
              onSession={activateSession}
            />
          )}
          {view === 'providers' && (
            <main className="page">
              <div className="page-heading">
                <div className="page-title-row">
                  <div>
                    <h1>{tr('模型')}</h1>
                    <p>{tr('管理模型服务与订阅账号，选择适合当前任务的模型。')}</p>
                  </div>
                </div>
              </div>
              <>
                <div className="info-strip">
                  <ShieldCheck size={17} />
                  <span>
                    {tr('API 密钥加密保存在本机。每次运行使用独立配置，切换连接不会覆盖已有会话。')}
                  </span>
                </div>
                <div className="collection-toolbar">
                  <label className="filter-input">
                    <Search size={15} />
                    <input
                      aria-label={tr('搜索模型连接')}
                      placeholder={tr('搜索名称、协议或地址')}
                      value={providerQuery}
                      onChange={(e) => setProviderQuery(e.target.value)}
                    />
                  </label>
                  <div className="row">
                    <button
                      className="secondary"
                      onClick={() => perform(async () => setPreview(await api.importCCSwitch()))}
                    >
                      <ArrowDownToLine size={15} />
                      {tr('导入 CC Switch')}
                    </button>
                    <button className="primary" onClick={editNewProvider}>
                      <Plus size={16} />
                      {tr('添加连接')}
                    </button>
                  </div>{' '}
                </div>
                <div className="provider-grid model-connections">
                  {data.providers
                    .filter((p) =>
                      `${p.name} ${p.protocol} ${p.baseUrl}`
                        .toLowerCase()
                        .includes(providerQuery.toLowerCase()),
                    )
                    .map((p) => (
                      <article className="provider-card" key={p.id}>
                        <div className="card-top">
                          <div
                            className={'provider-icon ' + p.protocol}
                            data-service={providerService(p)}
                          >
                            <ServiceIcon service={providerService(p)} size={23} />
                          </div>
                          {p.protocol === 'codex' ? (
                            <AuthBadge
                              connected={accountStates[p.id]?.connected}
                              pending={accountStates[p.id]?.pending}
                              error={accountStates[p.id]?.error}
                            />
                          ) : p.protocol === 'kimi' || p.protocol === 'minimax' ? (
                            <AuthBadge
                              connected={accountStates[p.id]?.connected}
                              pending={accountStates[p.id]?.pending}
                              error={accountStates[p.id]?.error}
                            />
                          ) : (
                            <span className="tag">
                              {p.auth === 'none'
                                ? tr('无需密钥')
                                : p.hasSecret
                                  ? tr('已配置密钥')
                                  : tr('待配置')}
                            </span>
                          )}
                          <button
                            className="icon-button"
                            aria-label={tr('编辑 ') + p.name}
                            onClick={() => setProviderEdit({ ...p, secret: '' })}
                          >
                            <SlidersHorizontal size={17} />
                          </button>
                        </div>
                        <h3>{providerLabel(p)}</h3>
                        <p>{protocolLabels[p.protocol]}</p>
                        <div className="provider-endpoint">
                          {p.baseUrl || protocolLabels[p.protocol] + tr(' · 官方账号')}
                        </div>
                        <div className="provider-availability">
                          <span className="muted">
                            {providerUnavailableReason(p, accountStates[p.id]) ||
                              tr('可在会话中选择')}
                          </span>
                          <label className="switch-control">
                            <input
                              type="checkbox"
                              role="switch"
                              aria-label={tr('启用连接 ') + p.name}
                              checked={providerToggles[p.id] ?? p.enabled !== false}
                              disabled={
                                p.id in providerToggles ||
                                data.runs.some(
                                  (r) => r.providerId === p.id && r.status === 'running',
                                )
                              }
                              onChange={(e) => {
                                const enabled = e.target.checked;
                                setProviderToggles((old) => ({ ...old, [p.id]: enabled }));
                                void perform(async () => {
                                  try {
                                    await api.saveProvider({ ...p, enabled });
                                    await refresh();
                                  } finally {
                                    setProviderToggles((old) => {
                                      const next = { ...old };
                                      delete next[p.id];
                                      return next;
                                    });
                                  }
                                });
                              }}
                            />
                            <span aria-hidden="true" />
                          </label>
                        </div>
                        <div className="card-footer">
                          <span>
                            <Layers3 size={13} />
                            {p.models.length
                              ? tr('{0} 个模型', [p.models.length])
                              : tr('登录或获取模型列表')}
                          </span>
                        </div>
                      </article>
                    ))}
                </div>
                {providerQuery &&
                  !data.providers.some((p) =>
                    `${p.name} ${p.protocol} ${p.baseUrl}`
                      .toLowerCase()
                      .includes(providerQuery.toLowerCase()),
                  ) && <p className="empty-record">{tr('没有匹配的连接，试试其他关键词。')}</p>}
                <div className="section-note">
                  <Network size={19} />
                  <div>
                    <strong>{tr('协议统一，能力保持透明')}</strong>
                    <p>
                      {tr(
                        '支持 Chat Completions、Responses、Anthropic 与 Gemini API。具体模型的工具调用能力需由服务支持；模型目录不代表账号已获得访问权限。',
                      )}
                    </p>
                  </div>
                </div>
              </>
            </main>
          )}
          {view === 'connections' && <ConnectionsPage api={api} data={data} refresh={refresh} />}
          {view === 'network' && (
            <main className="page settings-page">
              <div className="page-heading page-title-row">
                <h1>{tr('网络配置')}</h1>
                <button className="settings-back-button" onClick={() => setView('settings')}>
                  <ArrowLeft size={15} />
                  {tr('返回设置')}
                </button>
              </div>
              <NetworkProfilesPanel api={api} />
            </main>
          )}
          {view === 'extensions' && (
            <Extensions
              api={api}
              data={data}
              refresh={refresh}
              onAccountLogin={(engine, id) => {
                return perform(async () => {
                  let account =
                    data.providers.find((p) => p.id === id) ??
                    data.providers.find((p) => p.protocol === engine);
                  if (!account)
                    account = await api.saveProvider({
                      id: crypto.randomUUID(),
                      name: engine === 'kimi' ? 'Kimi' : 'MiniMax',
                      protocol: engine,
                      auth: 'native',
                      baseUrl: '',
                      models: [],
                      maxOutputTokens: 4096,
                      contextChars: 0,
                      enabled: true,
                    });
                  else if (account.enabled === false)
                    account = await api.saveProvider({ ...account, enabled: true });
                  await refresh();
                  setAuthProviderId(account.id);
                  setNativeAccounts({});
                  setAuthPanel(engine);
                  return account.id;
                });
              }}
            />
          )}
          {view === 'automations' && (
            <main className="page">
              <header className="page-heading">
                <div>
                  <h1>{tr('定时任务')}</h1>
                  <p>{tr('安排重复工作，集中查看执行结果。')}</p>
                </div>
              </header>
              <AutomationCenter
                api={api}
                data={data}
                onSession={activateSession}
                onDocument={(id, libraryId) => {
                  setKnowledgeTarget({ id, libraryId });
                  setKnowledgeSection('workspace');
                  setView('knowledge');
                }}
              />
            </main>
          )}
          {view === 'knowledge' && (
            <KnowledgeCenter
              onCanvas={(id) => {
                setCanvasTarget(id);
                setView('canvas');
              }}
              onAutomations={() => setView('automations')}
              initialDocument={knowledgeTarget}
              onNewChat={() => void newSession()}
              initialSection={knowledgeSection}
              artifactSession={artifactSession}
              onArtifact={(id, organize) => {
                setAttachmentPreview(undefined);
                setArtifactId(id);
                setArtifactOrganizing(!!organize);
              }}
              api={api}
              data={data}
              sessionId={sessionId}
              onSession={activateSession}
            />
          )}
          {view === 'agents' && (
            <AgentsPage
              api={api}
              data={data}
              providerId={providerId}
              running={!!running}
              refresh={refresh}
              perform={perform}
              onNavigate={setView}
              onUseAgent={(agent) => {
                setAgentId(agent.id);
                if (agent.providerId) setProviderId(agent.providerId);
                if (agent.model) setModel(agent.model);
                setView('workspace');
              }}
            />
          )}
          {view === 'activity' && (
            <main className="page">
              <div className="page-heading">
                <h1>{tr('运行记录')}</h1>
                <p>{tr('查看执行状态与用量，按会话审阅任务记忆、改动和验证依据。')}</p>
              </div>
              <div className="stats-grid">
                {[
                  { label: tr('累计运行'), value: data.runs.length },
                  {
                    label: tr('进行中'),
                    value: data.runs.filter((r) => r.status === 'running').length,
                  },
                  {
                    label: tr('已报告输入 Tokens'),
                    value: data.runs
                      .reduce((s, r) => s + r.inputTokens, 0)
                      .toLocaleString(getLocale()),
                  },
                  {
                    label: tr('已报告输出 Tokens'),
                    value: data.runs
                      .reduce((s, r) => s + r.outputTokens, 0)
                      .toLocaleString(getLocale()),
                  },
                ].map((s) => (
                  <div key={s.label}>
                    <span>{s.label}</span>
                    <strong>{s.value}</strong>
                  </div>
                ))}
              </div>
              <div className="task-tabs" role="tablist" aria-label={tr('运行记录视图')}>
                <button
                  role="tab"
                  aria-selected={activityTab === 'runs'}
                  onClick={() => setActivityTab('runs')}
                >
                  {tr('执行记录')}
                </button>
                <button
                  role="tab"
                  aria-selected={activityTab === 'review'}
                  onClick={() => {
                    setReviewSession(reviewSession || sessionId || data.sessions[0]?.id || '');
                    setActivityTab('review');
                  }}
                >
                  {tr('任务与交付')}
                </button>
              </div>
              {activityTab === 'runs' ? (
                <>
                  <div className="collection-toolbar">
                    <label className="filter-input">
                      <Search size={15} />
                      <input
                        aria-label={tr('搜索运行记录')}
                        placeholder={tr('搜索会话、Agent 或模型')}
                        value={runQuery}
                        onChange={(e) => setRunQuery(e.target.value)}
                      />
                    </label>
                    <select
                      aria-label={tr('筛选运行状态')}
                      value={runFilter}
                      onChange={(e) => setRunFilter(e.target.value)}
                    >
                      <option value="all">{tr('全部状态')}</option>
                      <option value="running">{tr('运行中')}</option>
                      <option value="completed">{tr('已完成')}</option>
                      <option value="failed">{tr('失败')}</option>
                      <option value="interrupted">{tr('已停止')}</option>
                    </select>
                  </div>
                  <div className="runs-table">
                    <div className="table-head">
                      <span>{tr('任务 / Agent')}</span>
                      <span>{tr('模型')}</span>
                      <span>{tr('状态')}</span>
                      <span>{tr('时间')}</span>
                      <span>Tokens</span>
                    </div>
                    {data.runs
                      .filter(
                        (r) =>
                          (runFilter === 'all' || r.status === runFilter) &&
                          `${data.sessions.find((s) => s.id === r.sessionId)?.title ?? ''} ${r.agentName} ${r.model}`
                            .toLowerCase()
                            .includes(runQuery.toLowerCase()),
                      )
                      .map((r) => (
                        <button
                          className="table-row"
                          key={r.id}
                          onClick={() => {
                            const selected = data.sessions.find((s) => s.id === r.sessionId);
                            if (selected) {
                              setReviewSession(selected.id);
                              setReviewRun(r.id);
                              setActivityTab('review');
                            }
                          }}
                        >
                          <span>
                            <strong>
                              {data.sessions.find((s) => s.id === r.sessionId)?.title ?? tr('会话')}
                            </strong>
                            <small>{r.agentName}</small>
                          </span>
                          <span>{r.model}</span>
                          <span>
                            <i className={'status-pill ' + r.status}>{statusLabel(r.status)}</i>
                          </span>
                          <span>
                            {new Date(r.startedAt).toLocaleString(getLocale(), {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                          <span>
                            {r.usageReported || r.inputTokens + r.outputTokens > 0
                              ? r.inputTokens + r.outputTokens
                              : tr('未上报')}
                          </span>
                        </button>
                      ))}
                    {data.runs.length > 0 &&
                      !data.runs.some(
                        (r) =>
                          (runFilter === 'all' || r.status === runFilter) &&
                          `${data.sessions.find((s) => s.id === r.sessionId)?.title ?? ''} ${r.agentName} ${r.model}`
                            .toLowerCase()
                            .includes(runQuery.toLowerCase()),
                      ) && (
                        <div className="empty-state compact">
                          <Search size={24} />
                          <p>{tr('没有符合条件的运行记录')}</p>
                        </div>
                      )}
                    {!data.runs.length && (
                      <div className="empty-state">
                        <Activity size={32} />
                        <h3>{tr('准备好启航')}</h3>
                        <p>{tr('开始一项任务后，运行记录会出现在这里。')}</p>
                        <button className="secondary" onClick={() => setView('workspace')}>
                          {tr('回到会话')}
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="footnote">
                    {tr(
                      '用量来自上游返回；“—”表示未报告或零用量，不代表免费。协作汇总记录不重复计算子任务 Token。',
                    )}
                  </p>
                </>
              ) : (
                <section className="activity-review" aria-label={tr('任务与交付审阅')}>
                  <div className="activity-review-heading">
                    <label htmlFor="review-session">{tr('审阅会话')}</label>
                    <select
                      id="review-session"
                      value={reviewSession}
                      onChange={(e) => {
                        setReviewSession(e.target.value);
                        setReviewRun('');
                      }}
                    >
                      <option value="" disabled>
                        {tr('选择会话')}
                      </option>
                      {data.sessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                          {s.archived ? tr(' · 已归档') : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      className="secondary"
                      disabled={!reviewSession}
                      onClick={() => {
                        const target = data.sessions.find((s) => s.id === reviewSession);
                        if (target) activateSession(target);
                      }}
                    >
                      {tr('打开会话')}
                    </button>
                  </div>
                  {reviewSession ? (
                    <TaskPanel
                      key={reviewSession + ':' + reviewRun}
                      api={api}
                      sessionId={reviewSession}
                      projectId={
                        data.sessions.find((s) => s.id === reviewSession)?.projectId ?? undefined
                      }
                      initialRunId={reviewRun}
                      onSelectSession={(id) => {
                        const target = data.sessions.find((s) => s.id === id);
                        if (target) activateSession(target);
                      }}
                    />
                  ) : (
                    <p className="task-empty">{tr('选择会话后查看任务与交付记录。')}</p>
                  )}
                </section>
              )}
            </main>
          )}
          {view === 'settings' && (
            <main className="page settings-page">
              <div className="page-heading">
                <h1>{tr('设置')}</h1>
                <p>{tr('CoSail · 开源多模型桌面工作台')}</p>
              </div>
              <section className="settings-card settings-link">
                <div className="settings-card-title">
                  <Network size={22} />
                  <div>
                    <h3>{tr('网络配置')}</h3>
                    <p>{tr('管理代理配置、网络内核和连接状态。')}</p>
                  </div>
                </div>
                <button className="secondary" onClick={() => setView('network')}>
                  {tr('管理网络配置 ')}
                  <ArrowRight size={14} />
                </button>
              </section>
              <Appearance value={appearance} onChange={setAppearance} />
              <PowerSettings api={api} />
              <UpdateControl api={api} settings />
              <DataMaintenance api={api} />
              <section className="settings-card">
                <div className="settings-card-title">
                  <ShieldCheck size={23} />
                  <div>
                    <h3>{tr('执行权限')}</h3>
                    <p>{tr('全局默认，也可为每个会话单独设置。')}</p>
                  </div>
                </div>
                <GlobalPermission
                  value={data.defaultPermission ?? 'ask'}
                  api={api}
                  onError={report}
                />
              </section>

              <section className="settings-card">
                <div className="settings-card-title">
                  <ShieldCheck size={23} />
                  <div>
                    <h3>{tr('权限与数据')}</h3>
                    <p>{tr('本地优先，模型调用直达你配置的服务。')}</p>
                  </div>
                </div>
                <div className="settings-row">
                  <span>{tr('会话与运行记录')}</span>
                  <strong>{tr('本地 SQLite 数据库')}</strong>
                </div>
                <div className="settings-row">
                  <span>{tr('API 密钥')}</span>
                  <strong>{tr('操作系统加密存储')}</strong>
                </div>
                <div className="settings-row">
                  <span>{tr('业务工具')}</span>
                  <strong>{tr('统一权限与文件范围检查')}</strong>
                </div>
                <div className="settings-row">
                  <span>{tr('统一执行核心')}</span>
                  <strong>{tr('Codex 原生沙箱与审批')}</strong>
                </div>
                <p className="footnote">
                  {tr(
                    'CoSail终端工具遵循会话权限，以当前系统用户权限运行；它不提供操作系统级沙箱。项目内容会发送给所选模型服务。CoSail不提供云同步或自动更新；账号登录客户端的遥测以各自实现为准。',
                  )}
                </p>
              </section>
              <section className="settings-card about-card">
                <Mark />
                <h3>{tr('多模型协作，一个工作台。')}</h3>
                <p>CoSail · Apache-2.0</p>
                <span>{tr('同舟：Co 代表协作，Sail 代表航行 · 一个工作台，多模型协作')}</span>
              </section>
            </main>
          )}
        </div>
        {historyOpen && (
          <Modal title={tr('搜索消息内容')} wide onClose={() => setHistoryOpen(false)}>
            <div className="task-panel">
              <HistorySearch
                api={api}
                onSelectSession={(id) => {
                  const target = data.sessions.find((s) => s.id === id);
                  if (target) activateSession(target);
                  setHistoryOpen(false);
                }}
              />
            </div>
          </Modal>
        )}
        {paletteOpen && (
          <CommandPalette
            onClose={() => setPaletteOpen(false)}
            actions={[
              {
                id: 'new',
                title: tr('开启新会话'),
                detail: tr('普通聊天 · 无需项目'),
                icon: Plus,
                run: () => void newSession(),
              },
              {
                id: 'project',
                title: tr('打开项目'),
                detail: tr('选择本地项目文件夹'),
                icon: FolderOpen,
                run: () => void openProject(),
              },
              ...nav.map((n) => ({
                id: n.id,
                title: n.label,
                detail:
                  n.id === 'providers'
                    ? tr('资源与工具 · 模型服务、订阅账号和 API 连接')
                    : n.id === 'connections'
                      ? tr('资源与工具 · 机器人和消息通知')
                      : tr('功能页面'),
                icon: n.icon,
                run: () => setView(n.id),
              })),

              {
                id: 'settings',
                title: tr('设置'),
                detail: tr('权限与本地数据'),
                icon: Settings2,
                run: () => setView('settings'),
              },
              ...data.sessions
                .filter((s) => !s.archived)
                .map((s) => ({
                  id: s.id,
                  title: s.title,
                  detail: data.projects.find((p) => p.id === s.projectId)?.name ?? tr('普通会话'),
                  icon: s.projectId ? Folder : MessageSquare,
                  run: () => activateSession(s),
                })),
            ]}
          />
        )}
        {notice && (
          <div className="toast" role="status">
            <span>{notice}</span>
            <button aria-label={tr('关闭提示')} onClick={() => setNotice('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {authPanel && (
          <Modal
            title={tr('{0} 账号授权', [
              authPanel === 'codex'
                ? 'OpenAI / ChatGPT'
                : authPanel === 'kimi'
                  ? 'Kimi Code'
                  : 'MiniMax Code',
            ])}
            subtitle={tr('仅管理当前连接的账号；关闭窗口不会取消正在进行的授权。')}
            onClose={() => {
              setAuthPanel(null);
              setAuthProviderId(undefined);
            }}
            wide
          >
            <div className="modal-content account-dialog">
              {authPanel === 'codex' && (
                <div className="info-strip">
                  <span>
                    {tr('账号网络：')}
                    {data.providers.find((p) => p.id === (authProviderId || 'openai-codex'))
                      ?.network?.mode === 'proxy'
                      ? tr('独立代理')
                      : data.providers.find((p) => p.id === (authProviderId || 'openai-codex'))
                            ?.network?.mode === 'direct'
                        ? tr('不使用代理')
                        : data.providers.find((p) => p.id === (authProviderId || 'openai-codex'))
                              ?.network?.mode === 'managed'
                          ? tr('内置网络配置')
                          : tr('默认网络')}
                  </span>
                  <button
                    className="text-button"
                    onClick={() => {
                      const p = data.providers.find(
                        (p) => p.id === (authProviderId || 'openai-codex'),
                      );
                      if (p) {
                        setAuthPanel(null);
                        setProviderEdit({ ...p, secret: '' });
                      }
                    }}
                  >
                    {tr('配置账号网络')}
                  </button>
                </div>
              )}
              <AccountLoginPanel
                only={authPanel}
                codex={codex}
                authPending={authPending}
                startLogin={startLogin}
                perform={perform}
                setCodex={setCodex}
                api={api}
                authPanel={authPanel}
                authProviderId={authProviderId}
                setNotice={setNotice}
                busy={busy}
                nativeAccounts={nativeAccounts}
                nativeRegions={nativeRegions}
                setNativeRegions={setNativeRegions}
              />
            </div>
          </Modal>
        )}
        {providerEdit && (
          <ProviderConnectionDialog
            data={data}
            providerEdit={providerEdit}
            busy={busy}
            setProviderEdit={setProviderEdit}
            perform={perform}
            api={api}
            normalizedProvider={normalizedProvider}
            refresh={refresh}
            setAuthProviderId={setAuthProviderId}
            setCodex={setCodex}
            setNativeAccounts={setNativeAccounts}
            setAuthPanel={setAuthPanel}
            setView={setView}
            fetchModels={fetchModels}
            saveProvider={saveProvider}
          />
        )}
        {deleteProjectId && (
          <Modal
            title={tr('删除项目')}
            onClose={() => {
              if (!busy) setDeleteProjectId('');
            }}
            compact
          >
            <div className="modal-content confirmation-content">
              <p>
                {tr('确认删除项目“')}
                <strong>{data.projects.find((p) => p.id === deleteProjectId)?.name}</strong>”？
              </p>
              <p className="project-delete-path">
                {data.projects.find((p) => p.id === deleteProjectId)?.path}
              </p>
              <p className="muted">
                {tr(
                  '项目内全部会话（含归档和内部子会话）、消息、运行记录和终端日志将一并删除，无法撤销。',
                )}
              </p>
              <p>
                {deleteProjectSessions
                  ? tr('已核对：共 {0} 个关联会话（含归档和子会话）。', [
                      deleteProjectSessions.length,
                    ])
                  : tr('正在核对项目会话…')}
              </p>
              {!!deleteProjectSessions?.length && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={deleteProjectAcknowledged}
                    onChange={(e) => setDeleteProjectAcknowledged(e.target.checked)}
                  />
                  {tr('我确认删除这些会话及记录')}
                </label>
              )}
              <p>
                <strong>{tr('磁盘上的项目文件与 Git 工作树目录会保留。')}</strong>
                {tr('关联的隔离工作目录仅从CoSail移除登记。')}
              </p>
              {deleteProjectError && (
                <p className="task-error" role="alert">
                  {deleteProjectError}
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button className="secondary" disabled={busy} onClick={() => setDeleteProjectId('')}>
                {tr('取消')}
              </button>
              <button
                className="destructive-button"
                disabled={
                  busy ||
                  !deleteProjectSessions ||
                  (!!deleteProjectSessions.length && !deleteProjectAcknowledged)
                }
                onClick={() =>
                  void perform(async () => {
                    setDeleteProjectError('');
                    try {
                      const deleted = await api.deleteProject(
                        deleteProjectId,
                        deleteProjectSessions,
                      );
                      for (const id of deleted) clearDraft(id);
                      if (deleted.includes(sessionId)) {
                        setSessionId('');
                        sessionRef.current = '';
                        setMessages([]);
                        setHasEarlier(false);
                        localStorage.removeItem('tongzhou-last-session');
                      }
                      for (const id of deleted) localStorage.removeItem(`tongzhou-workspace-${id}`);
                      if (deleted.includes(reviewSession)) {
                        setReviewSession('');
                        setReviewRun('');
                      }
                      setDeleteProjectId('');
                      await refresh();
                      setNotice(tr('项目已删除，磁盘文件已保留'));
                    } catch (e) {
                      setDeleteProjectError(errorMessage(e));
                    }
                  })
                }
              >
                {tr('确认删除项目')}
              </button>
            </div>
          </Modal>
        )}
        {deleteId && (
          <Modal title={tr('删除会话')} onClose={() => setDeleteId('')} compact>
            <div className="modal-content confirmation-content">
              <p>
                {tr('确认删除“')}
                <strong>
                  {data.sessions.find((s) => s.id === deleteId)?.title ?? tr('此会话')}
                </strong>
                ”？
              </p>
              <p className="muted">
                {tr('消息、运行记录和内部团队子会话将一并删除。项目文件和共享配置会保留。')}
              </p>
              {data.runs.some((r) => r.sessionId === deleteId && r.status === 'running') && (
                <p className="danger">{tr('请先停止任务，再删除归档会话。')}</p>
              )}
            </div>
            <div className="modal-footer">
              <button className="secondary" onClick={() => setDeleteId('')}>
                {tr('取消')}
              </button>
              <button
                className="destructive-button"
                disabled={
                  !data.sessions.find((s) => s.id === deleteId)?.archived ||
                  data.runs.some((r) => r.sessionId === deleteId && r.status === 'running')
                }
                onClick={() =>
                  perform(async () => {
                    await api.deleteSession(deleteId);
                    clearDraft(deleteId);
                    if (sessionId === deleteId) {
                      setSessionId('');
                      localStorage.removeItem('tongzhou-last-session');
                      sessionRef.current = '';
                      setMessages([]);
                    }
                    setDeleteId('');
                    await refresh();
                  })
                }
              >
                {tr('确认删除')}
              </button>
            </div>
          </Modal>
        )}
        {teamOpen && (
          <Modal
            title={tr('邀请伙伴，一起分析')}
            subtitle={tr('最多选择 3 位 Agent，独立只读分析后将结论汇回当前会话。')}
            onClose={() => setTeamOpen(false)}
          >
            <div className="modal-content team-options">
              {data.agents
                .filter((a) => !a.builtin)
                .map((a) => (
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
                    <span className="tag">{tr('只读')}</span>
                  </label>
                ))}
            </div>
            <div className="modal-footer">
              <span className="muted">{tr('每位 Agent 独立产生模型用量')}</span>
              <span className="spacer" />
              <button
                className="primary"
                disabled={!teamIds.length || busy}
                onClick={() => send(true)}
              >
                <Users size={16} />
                {tr('开始协作')}
              </button>
            </div>
          </Modal>
        )}
        {preview && (
          <Modal
            title={tr('导入 CC Switch')}
            subtitle={tr('原始配置保持不变，请确认需要导入的连接。')}
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
                  <span className="tag">{p.hasSecret ? tr('包含密钥') : tr('需配置密钥')}</span>
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
                    setNotice(tr('导入完成'));
                  } catch (e) {
                    report(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {tr('导入 ')}
                {preview.providers.length}
                {tr(' 个连接')}
                <ArrowRight size={15} />
              </button>
            </div>
          </Modal>
        )}
        {attachmentPreview && (
          <AttachmentPreview
            item={attachmentPreview}
            layout={workspace}
            updateLayout={updateWorkspace}
            onClose={() => setAttachmentPreview(undefined)}
          />
        )}
        {artifactId && (
          <ArtifactDetail
            key={artifactId}
            layout={workspace}
            updateLayout={updateWorkspace}
            initialOrganizing={artifactOrganizing}
            id={artifactId}
            api={api}
            data={data}
            onClose={() => {
              setArtifactId(undefined);
              setArtifactOrganizing(false);
            }}
            onSource={(id) => {
              const source = data.sessions.find((s) => s.id === id);
              if (source) {
                activateSession(source);
                setArtifactId(undefined);
                setArtifactOrganizing(false);
              }
            }}
            onContinue={(item, instruction) => {
              const source = data.sessions.find((s) => s.id === item.sessionId);
              if (!source) return;
              activateSession(source);
              setSessionDraft(source.id, (old) =>
                tr('{0}继续处理作品「{1}」（作品 ID：{2}）：{3}', [
                  old ? old + '\n\n' : '',
                  item.name,
                  item.id,
                  instruction ?? '',
                ]),
              );
              setArtifactId(undefined);
              setArtifactOrganizing(false);
            }}
            onKnowledge={(id, libraryId) => {
              setKnowledgeTarget({ id, libraryId });
              setKnowledgeSection('workspace');
              setView('knowledge');
              setArtifactId(undefined);
              setArtifactOrganizing(false);
            }}
            onDeleted={() => {
              setArtifactId(undefined);
              setArtifactOrganizing(false);
              setArtifactRevision((n) => n + 1);
              void refresh();
            }}
          />
        )}
      </div>
    </FilePreviewContext.Provider>
  );
}

const modelStages = localized(raw_modelStages);
