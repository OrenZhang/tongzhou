import { CanvasComfyFields } from './CanvasComfyFields';
import { providerLabel } from '../../shared/provider-label';
import { t as tr, getLocale, localize as localized } from '../../shared/i18n';
import { Modal } from '../../components/components';
import { CanvasLibrary } from './CanvasLibrary';
import { CanvasWorkflowFields } from './CanvasWorkflowFields';
import { CanvasSplitFields, CanvasSplitResults } from './CanvasSplit';
import { CanvasConnections } from './CanvasConnections';
import { splitPluginId, splitCategories } from '../../shared/canvas-ports';
import { registerCanvasDraft } from './draft-sync';
import { CanvasAssistant } from './CanvasAssistant';
import { mergeCanvasChanges } from '../../shared/canvas-collaboration';
import { duplicateSelection, alignSelection } from '../../shared/canvas-editing';
import {
  CanvasMediaFields,
  CanvasMediaResults,
  CanvasOutputLocation,
  CanvasResourceOutput,
} from './CanvasMedia';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { emptyWhiteboard } from '../../shared/whiteboard';
import {
  Plus,
  Play,
  Save,
  Square,
  Trash2,
  Undo2,
  Redo2,
  Copy,
  X,
  Settings2,
  MessageSquare,
  ArrowLeft,
} from 'lucide-react';
import type {
  Canvas,
  CanvasNode,
  CanvasNodeKind,
  CanvasResource,
  CanvasState,
} from '../../shared/canvas';
import { canvasNodeKinds as raw_canvasNodeKinds } from '../../shared/canvas';
import type { Session, Snapshot, TongzhouAPI } from '../../shared/types';
import { effectivePermission } from '../../shared/permissions';
import { isUserSession } from '../../shared/session-scope';
import { CanvasBoard } from './CanvasBoard';
import { CanvasNodePalette } from './CanvasNodePalette';
import { StudioHome } from './StudioHome';
import { CanvasSourcePicker } from './CanvasSourcePicker';
import { CanvasTextSource } from './CanvasTextSource';
import { CanvasPluginFields } from './CanvasPluginFields';
import { errorMessage } from '../../lib/feedback';
import './canvas.css';
const WhiteboardBoard = lazy(() => {
  Object.assign(window, {
    EXCALIDRAW_ASSET_PATH: new URL('./excalidraw-assets/', document.baseURI).href,
  });
  return import('./WhiteboardBoard');
});

export function CanvasWorkspace({
  api,
  data,
  sessionId,
  initialCanvasId,
  onSession,
  onClose,
  compact = false,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  sessionId?: string;
  initialCanvasId?: string;
  onSession(s: Session): void;
  onClose?: () => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<CanvasState>({ canvases: [], canvas: null, runs: [] }),
    [canvas, setCanvas] = useState<Canvas | null>(null),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [picker, setPicker] = useState<'add' | 'replace' | false>(false),
    [inspector, setInspector] = useState<string>(),
    [settingsOpen, setSettingsOpen] = useState(false),
    [chatOpen, setChatOpen] = useState(false),
    [conflict, setConflict] = useState<Canvas>(),
    [reuse, setReuse] = useState(true),
    [owner, setOwner] = useState(sessionId ?? ''),
    [runId, setRunId] = useState(''),
    [library, setLibrary] = useState<'prompt' | 'template'>(),
    [notice, setNotice] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const home = useRef(true);
  const homeBoundCanvas = useRef<string | undefined>(undefined);
  const [composerTarget, setComposerTarget] = useState<HTMLDivElement | null>(null);
  const selectedNodeId =
    canvas?.selection.length === 1 && canvas.nodes.some((n) => n.id === canvas.selection[0])
      ? canvas.selection[0]
      : '';
  useEffect(() => {
    setChatOpen(false);
    setConfigOpen(false);
  }, [canvas?.id]);
  useEffect(() => {
    if (!selectedNodeId) setConfigOpen(false);
  }, [selectedNodeId]);
  const showConfig = configOpen && !!selectedNodeId;
  const [mediaHistory, setMediaHistory] = useState<string>();
  const [historyRunId, setHistoryRunId] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [draftStatus, setDraftStatus] = useState<'pending' | 'stored' | 'failed'>('pending');
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>([
    { id: 'default', name: tr('我的内容') },
  ]);
  useEffect(() => {
    let active = true;
    void api
      .contentState('default')
      .then((s) => {
        if (active) setLibraries(s.libraries);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    setInspector(undefined);
    setMediaHistory(undefined);
    setSaveStatus('idle');
    setSettingsOpen(false);
  }, [canvas?.id]);
  const workspace = useRef<HTMLElement>(null);
  const resourceDrop = useRef<{ x: number; y: number }>(undefined);
  const validateConfig = () => {
    const invalid = workspace.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '.canvas-inspector input:invalid,.canvas-inspector textarea:invalid,.canvas-media-composer input:invalid',
    );
    if (invalid) {
      invalid.reportValidity();
      throw new Error(tr('请检查节点插件的扩展参数'));
    }
  };
  const boundCanvas = useRef<string | undefined>(undefined);
  boundCanvas.current = data.sessions.find((s) => s.id === owner)?.activeCanvasId;
  const current = useRef(canvas),
    savedBase = useRef<Canvas | null>(null),
    conflictRef = useRef<Canvas | undefined>(undefined),
    dirtyRef = useRef(dirty),
    request = useRef(0),
    opening = useRef(0),
    undo = useRef<Canvas[]>([]),
    redo = useRef<Canvas[]>([]);
  current.current = canvas;
  dirtyRef.current = dirty;
  const perform = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const draftKey = (id: string) => 'tongzhou.canvas.draft.' + id;
  useEffect(() => {
    const persistDraft = () => {
      const value = current.current;
      if (value && dirtyRef.current)
        try {
          localStorage.setItem(draftKey(value.id), JSON.stringify(value));
          setDraftStatus('stored');
        } catch {
          setDraftStatus('failed');
          /* The explicit save action remains available if browser storage is full. */
        }
    };
    if (dirty) setDraftStatus('pending');
    const timer = setTimeout(persistDraft, 400);
    return () => {
      clearTimeout(timer);
      persistDraft();
    };
  }, [canvas, dirty]);
  const load = useCallback(
    async (id?: string, force = false, restoreDraft = false) => {
      // Background changed events must not cancel an explicit canvas switch.
      if (!force && opening.current) return;
      const seq = ++request.current;
      if (force) opening.current = seq;
      try {
        const result = await api.canvasState(id);
        if (seq !== request.current) return;
        setState(result);
        // Listing the studio must not implicitly open canvasState's latest item.
        if (!id && home.current) return;
        const local = current.current,
          remote = result.canvas,
          base = savedBase.current;
        if (
          !force &&
          local &&
          remote &&
          base?.id === local.id &&
          remote.id === local.id &&
          remote.version > base.version &&
          dirtyRef.current
        ) {
          const merged = mergeCanvasChanges(base, local, remote);
          if (merged.conflicts.length) {
            conflictRef.current = remote;
            setConflict(remote);
            return;
          }
          undo.current = local.mode === 'whiteboard' ? [] : [local];
          redo.current = [];
          current.current = merged.canvas;
          savedBase.current = remote;
          dirtyRef.current = merged.dirty;
          setCanvas(merged.canvas);
          setDirty(merged.dirty);
          conflictRef.current = undefined;
          setConflict(undefined);
          setNotice(tr('已同步 AI／其他窗口的修改，并保留你的本地编辑。'));
          return;
        }
        if (force || !dirtyRef.current) {
          let next = result.canvas,
            restored = false;
          if (next && restoreDraft)
            try {
              const draft = JSON.parse(
                localStorage.getItem(draftKey(next.id)) ?? 'null',
              ) as Canvas | null;
              if (draft?.id === next.id && draft.version === next.version) {
                next = draft;
                restored = true;
              } else if (draft) setError(tr('画布已有新版本，本地草稿仍保留；请先核对当前内容。'));
            } catch {
              /* Ignore malformed browser drafts. */
            }
          if (!force && local && next?.id === local.id && next.version > local.version) {
            if (local.mode !== 'whiteboard') undo.current.push(local);
            redo.current = [];
            if (undo.current.length > 80) undo.current.shift();
            setNotice(tr('画布已更新，可撤销本次修改。'));
          }
          savedBase.current = result.canvas;
          conflictRef.current = undefined;
          setConflict(undefined);
          current.current = next;
          dirtyRef.current = restored;
          setCanvas(next);
          setDirty(restored);
          home.current = !next;
        }
      } finally {
        if (opening.current === seq) opening.current = 0;
      }
    },
    [api],
  );
  useEffect(() => {
    home.current = true;
    homeBoundCanvas.current = data.sessions.find((s) => s.id === sessionId)?.activeCanvasId;
    current.current = null;
    savedBase.current = null;
    dirtyRef.current = false;
    setCanvas(null);
    setDirty(false);
    void (async () => {
      if (initialCanvasId && sessionId) await api.canvasBind(sessionId, initialCanvasId);
      await load(
        initialCanvasId ??
          (compact ? data.sessions.find((s) => s.id === sessionId)?.activeCanvasId : undefined),
        true,
        true,
      );
    })().catch((e) => setError(errorMessage(e)));
    setOwner(sessionId ?? '');
  }, [api, sessionId, compact, initialCanvasId]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onEvent((e) => {
      if (e.type !== 'changed') return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        // A save emits changed before its IPC response arrives. Wait for that save so
        // our own echo is not treated as an external edit that replaces undo history.
        void (async () => {
          if (saving.current) await saving.current;
          const target = home.current
            ? compact && boundCanvas.current !== homeBoundCanvas.current
              ? boundCanvas.current
              : undefined
            : (current.current?.id ?? boundCanvas.current);
          await load(target);
        })().catch((e) => setError(errorMessage(e)));
      }, 180);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [api, load, compact]);
  const change = useCallback((next: Canvas, record = true) => {
    if (record && current.current) {
      undo.current.push(current.current);
      if (undo.current.length > 80) undo.current.shift();
    }
    if (record) redo.current = [];
    current.current = next;
    dirtyRef.current = true;
    setCanvas(next);
    setDirty(true);
  }, []);
  const select = useCallback(
    (ids: string[]) => {
      const c = current.current;
      if (c) change({ ...c, selection: ids });
      setConfigOpen(ids.length === 1 && !!c?.nodes.some((n) => n.id === ids[0]));
    },
    [change],
  );
  const activeRun = state.runs.find((r) => r.status === 'running'),
    shownRun = state.runs.find((r) => r.id === runId) ?? state.runs[0];
  const node = canvas?.nodes.find((n) => n.id === (inspector ?? canvas.selection[0]));
  const inlineMedia = node?.kind === 'image' || node?.kind === 'video';
  const mediaHistoryRuns = state.runs.filter(
    (r) => mediaHistory && r.nodes[mediaHistory]?.generation?.length,
  );
  const mediaHistoryRun =
    mediaHistoryRuns.find((r) => r.id === historyRunId) ?? mediaHistoryRuns[0];
  const ownerSession = data.sessions.find((s) => s.id === owner),
    readOnly =
      effectivePermission(
        ownerSession,
        data.defaultPermission,
        data.agents.find((a) => a.id === ownerSession?.agentId),
      ) === 'read-only';
  const saving = useRef<Promise<Canvas | undefined> | null>(null);
  const save = (): Promise<Canvas | undefined> => {
    if (saving.current) return saving.current;
    setSaveStatus('saving');
    const pending = saveOnce();
    void pending.then(
      () => setSaveStatus('idle'),
      () => setSaveStatus('failed'),
    );
    saving.current = pending;
    void pending
      .finally(() => {
        if (saving.current === pending) saving.current = null;
      })
      .catch(() => {});
    return pending;
  };
  const saveOnce = async () => {
    if (current.current) await load(current.current.id);
    if (conflictRef.current) throw new Error(tr('请先处理画布修改冲突'));
    const c = current.current;
    if (!c) return;
    if (!dirtyRef.current) return c;
    const { updatedAt: _, ...input } = c,
      next = await api.canvasSave(input);
    try {
      localStorage.removeItem(draftKey(c.id));
    } catch {}
    if (owner) await api.canvasBind(owner, next.id);
    if (current.current?.id !== c.id) return next;
    savedBase.current = next;
    if (current.current !== c && current.current?.id === c.id) {
      const edited = { ...current.current, version: next.version };
      current.current = edited;
      setCanvas(edited);
      dirtyRef.current = true;
      setDirty(true);
      return next;
    }
    current.current = next;
    dirtyRef.current = false;
    setCanvas(next);
    setDirty(false);
    await load(next.id);
    return next;
  };
  const flush = useRef(async () => {});
  flush.current = async () => {
    for (let i = 0; i < 8 && (dirtyRef.current || saving.current); i++) await save();
    if (dirtyRef.current) throw new Error(tr('画布仍在编辑，请稍后发送'));
    if (owner && current.current) await api.canvasBind(owner, current.current.id);
  };
  useEffect(() => (owner ? registerCanvasDraft(owner, () => flush.current()) : undefined), [owner]);
  useEffect(() => {
    if (canvas?.mode !== 'whiteboard' || !dirty || conflict || saveStatus === 'failed') return;
    const timer = setTimeout(
      () => void flush.current().catch((e) => setError(errorMessage(e))),
      900,
    );
    return () => clearTimeout(timer);
  }, [canvas, dirty, conflict, saveStatus]);
  const bindOwner = async (id: string) => {
    if (dirtyRef.current) await flush.current();
    if (id && current.current) await api.canvasBind(id, current.current.id);
    setOwner(id);
  };
  const createChat = async () => {
    if (!current.current) return;
    await flush.current();
    const created = await api.createSession(ownerSession?.projectId ?? null);
    await api.setSessionPermission(created.id, 'full-access');
    await api.updateSession(created.id, {
      title: tr('{0} · 画布聊天', [current.current.title]),
      ...(ownerSession ? { providerId: ownerSession.providerId, model: ownerSession.model } : {}),
    });
    await api.canvasBind(created.id, current.current.id);
    setOwner(created.id);
  };
  const create = async (mode: 'workflow' | 'whiteboard' = 'workflow') => {
    const next = await api.canvasSave({
      title: mode === 'whiteboard' ? tr('未命名白板') : tr('未命名画布'),
      ...(mode === 'whiteboard' ? { mode, whiteboard: emptyWhiteboard() } : {}),
      nodes: [],
      edges: [],
      selection: [],
      viewport: { x: 40, y: 40, zoom: 1 },
    });
    if (owner) await api.canvasBind(owner, next.id);
    else {
      const session = await api.createSession(null);
      await api.updateSession(session.id, { title: tr('{0} · 画布聊天', [next.title]) });
      await api.setSessionPermission(session.id, 'full-access');
      await api.canvasBind(session.id, next.id);
      setOwner(session.id);
    }
    undo.current = [];
    redo.current = [];
    await load(next.id, true);
  };
  const importWhiteboard = () =>
    void perform(async () => {
      await flush.current();
      const next = await api.whiteboardImport();
      if (!next) return;
      if (owner) await api.canvasBind(owner, next.id);
      await load(next.id, true);
    });
  const add = (
    type: CanvasNodeKind,
    title?: string,
    resource?: CanvasResource,
    pluginId?: string,
    position?: { x: number; y: number },
  ) => {
    const c = current.current;
    if (!c) return;
    if (c.nodes.length >= 200) {
      setError(tr('画布最多支持 200 个节点'));
      return;
    }
    const id = crypto.randomUUID(),
      i = c.nodes.length;
    const defaults = structuredClone(state.plugins?.find((p) => p.id === pluginId)?.defaults ?? {});
    const width = defaults.width ?? 240,
      height = defaults.height ?? 180;
    const column = Math.max(width, ...c.nodes.map((n) => n.width ?? 240)) + 40;
    const row = Math.max(height, ...c.nodes.map((n) => n.height ?? 180)) + 40;
    const x = position?.x ?? (i % 4) * column;
    let y = position?.y ?? Math.floor(i / 4) * row;
    while (
      !position &&
      c.nodes.some(
        (n) =>
          x < n.x + (n.width ?? 240) + 20 &&
          x + width + 20 > n.x &&
          y < n.y + (n.height ?? 180) + 20 &&
          y + height + 20 > n.y,
      )
    )
      y += row;
    const board = workspace.current?.querySelector('.canvas-board');
    change({
      ...c,
      viewport:
        !position && board
          ? {
              ...c.viewport,
              x: board.clientWidth / 2 - (x + width / 2) * c.viewport.zoom,
              y: board.clientHeight / 2 - (y + height / 2) * c.viewport.zoom,
            }
          : c.viewport,
      nodes: [
        ...c.nodes,
        {
          id,
          kind: type,
          ...defaults,
          ...(pluginId ? { pluginId } : {}),
          title: title ?? canvasNodeKinds[type],
          x,
          y,
          ...(resource ? { resource } : {}),
          ...(type === 'save' ? { libraryId: 'default' } : {}),
          ...(['image', 'video', 'audio'].includes(type)
            ? {
                media: {
                  count: 1,
                  mode: 'text' as const,
                  destination: { kind: 'artifacts' as const },
                },
              }
            : {}),
        },
      ],
      selection: [id],
    });
  };
  const addFromPalette = (pluginId: string, position?: { x: number; y: number }) => {
    const c = current.current;
    const plugin = state.plugins?.find((p) => p.id === pluginId);
    if (!c || !plugin || busy || conflictRef.current) return;
    if (pluginId === 'resource') {
      resourceDrop.current = position;
      setPicker('add');
    } else add(plugin.kind, tr(plugin.name), undefined, plugin.id, position);
  };
  const patch = (patch: Partial<CanvasNode>) => {
    if (canvas && node)
      change({
        ...canvas,
        nodes: canvas.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)),
        edges:
          node.pluginId === splitPluginId && patch.config
            ? canvas.edges.filter(
                (e) =>
                  e.from !== node.id ||
                  !e.fromPort ||
                  splitCategories({ ...node, ...patch }).some((c) => c.id === e.fromPort),
              )
            : canvas.edges,
      });
  };
  const history = (direction: 'undo' | 'redo') => {
    const from = direction === 'undo' ? undo : redo,
      to = direction === 'undo' ? redo : undo,
      value = from.current.pop();
    if (value && canvas) {
      to.current.push(canvas);
      const next = { ...value, version: canvas.version };
      current.current = next;
      dirtyRef.current = true;
      setCanvas(next);
      setDirty(true);
    }
  };
  const remove = (ids?: string[]) => {
    const c = current.current;
    if (!c) return;
    const removed = new Set(ids ?? c.selection);
    if (!c.nodes.some((n) => removed.has(n.id))) return;
    change({
      ...c,
      nodes: c.nodes.filter((n) => !removed.has(n.id)),
      edges: c.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to)),
      selection: c.selection.filter((id) => !removed.has(id)),
    });
  };
  const execute = (selected = false, nodeId?: string) =>
    void perform(async () => {
      validateConfig();
      if (!owner) throw new Error(tr('请选择执行会话'));
      await flush.current();
      const c = current.current;
      if (!c) return;
      const r = await api.canvasExecute({
        canvasId: c.id,
        version: c.version,
        sessionId: owner,
        nodeIds: nodeId ? [nodeId] : selected ? c.selection : undefined,
        reuse,
      });
      setRunId(r.id);
      await load(c.id);
    });
  const saveReferenced = () =>
    void perform(async () => {
      if (!owner || !node) throw new Error(tr('请选择执行会话和媒体节点'));
      await flush.current();
      const c = current.current;
      if (!c) return;
      const run = await api.canvasExecute({
        canvasId: c.id,
        version: c.version,
        sessionId: owner,
        nodeIds: [node.id],
        saveResource: true,
      });
      setRunId(run.id);
      await load(c.id);
    });
  const regenerate = (
    nodeId: string,
    index?: number,
    action: NonNullable<
      import('../../shared/canvas').CanvasExecute['regenerate']
    >['action'] = 'generate',
  ) =>
    void perform(async () => {
      validateConfig();
      if (!owner) throw new Error(tr('请选择执行会话'));
      await flush.current();
      const c = current.current;
      if (!c) return;
      const r = await api.canvasExecute({
        canvasId: c.id,
        version: c.version,
        sessionId: owner,
        nodeIds: [nodeId],
        reuse: true,
        regenerate: {
          sourceRunId: shownRun?.id,
          nodeId,
          indices: index === undefined ? undefined : [index],
          action,
        },
      });
      setRunId(r.id);
      await load(c.id);
    });
  const nodeConfiguration =
    canvas && node ? (
      <div className="canvas-inspector canvas-config-form">
        {inlineMedia && (
          <button onClick={() => setInspector(undefined)}>{tr('返回生成配置')}</button>
        )}
        {node ? (
          <>
            <h3>
              {state.plugins?.find((p) => p.id === (node.pluginId ?? node.kind))?.name ??
                canvasNodeKinds[node.kind]}
            </h3>
            {state.plugins?.find((p) => p.id === (node.pluginId ?? node.kind))?.description && (
              <small>
                {state.plugins.find((p) => p.id === (node.pluginId ?? node.kind))?.description}
              </small>
            )}
            <label>
              {tr('节点名称')}
              <input value={node.title} onChange={(e) => patch({ title: e.target.value })} />
            </label>
            {(node.kind === 'text' ||
              ['visual.html', 'visual.svg', 'visual.markdown'].includes(node.pluginId ?? '')) && (
              <CanvasTextSource
                key={canvas.id + ':' + node.id}
                api={api}
                data={data}
                node={node}
                sessionId={owner}
                patch={patch}
              />
            )}
            {['image', 'video', 'audio'].includes(node.kind) && (
              <CanvasOutputLocation
                api={api}
                destination={node.media?.destination}
                onChange={(destination) => patch({ media: { ...node.media, destination } })}
                onError={(e) => setError(errorMessage(e))}
              />
            )}
            {node.kind === 'resource' ? (
              <>
                <CanvasResourceOutput
                  api={api}
                  node={node}
                  patch={patch}
                  busy={busy || !!activeRun || readOnly}
                  onError={(e) => setError(errorMessage(e))}
                  onSave={saveReferenced}
                />
                <label>
                  {tr('自定义提示词')}
                  <textarea
                    aria-label={tr('自定义提示词')}
                    rows={3}
                    value={node.text ?? ''}
                    placeholder={tr('补充生成要求，随引用内容传给下游媒体节点')}
                    onChange={(e) => patch({ text: e.target.value })}
                  />
                </label>
                <button onClick={() => setPicker('replace')}>{tr('更换引用资源')}</button>
                <small>
                  {node.resource
                    ? {
                        content: tr('内容库'),
                        artifact: tr('会话作品'),
                        message: tr('会话消息'),
                        file: tr('项目文件'),
                      }[node.resource.kind]
                    : tr('尚未选择资源')}
                  {node.resource?.kind === 'content'
                    ? ' · v' + node.resource.version
                    : node.resource?.kind === 'file'
                      ? ' · ' + node.resource.path
                      : ''}
                </small>
              </>
            ) : (
              node.kind !== 'save' &&
              node.definition?.adapter !== 'comfyui' &&
              node.pluginId !== 'comfyui.workflow' &&
              !inlineMedia && (
                <label>
                  {tr(state.plugins?.find((p) => p.id === node.pluginId)?.view?.textLabel ?? '') ||
                    (node.kind === 'text'
                      ? tr('正文')
                      : ['image', 'video', 'audio'].includes(node.kind)
                        ? tr('生成提示词')
                        : tr('处理要求'))}
                  <textarea
                    aria-label={
                      tr(
                        state.plugins?.find((p) => p.id === node.pluginId)?.view?.textLabel ?? '',
                      ) ||
                      (node.kind === 'text'
                        ? tr('正文')
                        : ['image', 'video', 'audio'].includes(node.kind)
                          ? tr('生成提示词')
                          : tr('处理要求'))
                    }
                    value={node.text ?? ''}
                    rows={5}
                    onChange={(e) => patch({ text: e.target.value })}
                  />
                </label>
              )
            )}
            {['workflow.schedule', 'workflow.notify'].includes(node.pluginId ?? '') && (
              <CanvasWorkflowFields
                key={'workflow:' + node.id}
                api={api}
                canvas={canvas}
                node={node}
                owner={ownerSession}
                patch={patch}
                save={save}
              />
            )}
            {node.kind === 'plugin' &&
              node.definition?.adapter !== 'comfyui' &&
              node.pluginId !== 'comfyui.workflow' &&
              !['workflow.schedule', 'workflow.notify'].includes(node.pluginId ?? '') && (
                <CanvasPluginFields
                  data={data}
                  definition={state.plugins?.find((p) => p.id === (node.pluginId ?? node.kind))}
                  node={node}
                  patch={patch}
                />
              )}
            {(node.definition?.adapter === 'comfyui' || node.pluginId === 'comfyui.workflow') && (
              <CanvasComfyFields
                data={data}
                canvas={canvas}
                node={node}
                run={shownRun}
                disabled={busy || readOnly || !!activeRun}
                patch={patch}
                onCheck={async (connectionId) =>
                  (await perform(async () => {
                    await flush.current();
                    const c = current.current;
                    if (!c) return [];
                    const result = await api.canvasConfigureComfy(c.id, c.version, connectionId);
                    await load(c.id);
                    return result.warnings.length
                      ? result.warnings
                      : [tr('ComfyUI 节点定义已更新')];
                  })) ?? []
                }
                onExport={async () => {
                  await flush.current();
                  const c = current.current;
                  if (c) await api.canvasExportComfy(c.id, c.version);
                }}
                onResume={async () => {
                  await flush.current();
                  const c = current.current;
                  if (!c || !shownRun || !owner) throw new Error(tr('请选择执行会话'));
                  const r = await api.canvasExecute({
                    canvasId: c.id,
                    version: c.version,
                    sessionId: owner,
                    nodeIds: [node.id],
                    resumeRunId: shownRun.id,
                  });
                  setRunId(r.id);
                  await load(c.id);
                }}
              />
            )}
            {state.plugins?.find((p) => p.id === node.pluginId)?.view?.resource === 'image' && (
              <button onClick={() => setPicker('replace')}>
                {node.resource ? tr('更换全景图片') : tr('选择全景图片')}
              </button>
            )}
            {node.kind === 'agent' && (
              <>
                <label>
                  {tr('模型连接')}
                  <select
                    value={node.providerId ?? ''}
                    onChange={(e) =>
                      patch({
                        providerId: e.target.value || undefined,
                        model: data.providers.find((p) => p.id === e.target.value)?.models[0],
                      })
                    }
                  >
                    <option value="">{tr('跟随执行会话')}</option>
                    {data.providers
                      .filter((p) => p.enabled !== false)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {providerLabel(p)}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  {tr('模型')}
                  <select
                    value={node.model ?? ''}
                    onChange={(e) => patch({ model: e.target.value || undefined })}
                  >
                    <option value="">{tr('跟随执行会话')}</option>
                    {data.providers
                      .find((p) => p.id === (node.providerId || ownerSession?.providerId))
                      ?.models.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                  </select>
                </label>
                <label>
                  Agent
                  <select
                    value={node.agentId ?? ''}
                    onChange={(e) => patch({ agentId: e.target.value || undefined })}
                  >
                    <option value="">{tr('跟随执行会话')}</option>
                    {data.agents
                      .filter((a) => !['knowledge-organizer', 'memory-organizer'].includes(a.id))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
            {node.pluginId === splitPluginId && <CanvasSplitFields node={node} patch={patch} />}
            {node.pluginId === splitPluginId && (
              <CanvasSplitResults
                canvas={canvas}
                node={node}
                output={shownRun?.nodes[node.id]?.output}
                onChange={change}
                onError={(e) => setError(errorMessage(e))}
              />
            )}
            {['image', 'video', 'audio'].includes(node.kind) && (
              <CanvasMediaFields
                advancedOnly={inlineMedia}
                api={api}
                data={data}
                node={node}
                patch={patch}
                onError={(e) => setError(errorMessage(e))}
              />
            )}
            {node.kind === 'save' && (
              <label>
                {tr('目标内容库')}
                <select
                  value={node.libraryId ?? 'default'}
                  onChange={(e) => patch({ libraryId: e.target.value, folderId: undefined })}
                >
                  {libraries.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!inlineMedia && (
              <CanvasConnections
                key={node.id}
                canvas={canvas}
                node={node}
                plugins={state.plugins ?? []}
                onChange={change}
                onError={(e) => setError(errorMessage(e))}
              />
            )}
            {node.kind === 'audio' && node.media?.mode !== 'existing' && (
              <>
                <button
                  className="primary"
                  disabled={busy || !!activeRun || readOnly}
                  onClick={() => regenerate(node.id)}
                >
                  {tr('生成')}
                  {tr('音频')} · {node.media?.count ?? 1}
                  {tr('条')}
                </button>
                <CanvasMediaResults
                  api={api}
                  key={node.id}
                  previewKey={`tongzhou.canvas.preview.${canvas.id}.${node.id}.${shownRun?.id ?? 'new'}`}
                  step={shownRun?.nodes[node.id]}
                  disabled={busy || !!activeRun || readOnly}
                  onRegenerate={(index, action) => regenerate(node.id, index, action)}
                  onError={(e) => setError(errorMessage(e))}
                />
              </>
            )}
            {node.media?.mode === 'existing' && (
              <CanvasResourceOutput
                api={api}
                node={node}
                patch={patch}
                showLocation={false}
                busy={busy || !!activeRun || readOnly}
                onSave={saveReferenced}
                onError={(e) => setError(errorMessage(e))}
              />
            )}
            {shownRun?.nodes[node.id] && !['image', 'video', 'audio'].includes(node.kind) && (
              <>
                <h3>{tr('所选运行结果')}</h3>
                <p className="canvas-result">
                  {shownRun.nodes[node.id].error ||
                    shownRun.nodes[node.id].output?.text ||
                    shownRun.nodes[node.id].status}
                </p>
                {shownRun.nodes[node.id].taskSessionId && (
                  <button
                    onClick={() => {
                      const s = data.sessions.find(
                        (s) => s.id === shownRun.nodes[node.id].taskSessionId,
                      );
                      if (s) onSession(s);
                    }}
                  >
                    {tr('查看执行过程／处理审批')}
                  </button>
                )}
              </>
            )}
          </>
        ) : (
          <p>{tr('选中节点以编辑；Shift 点击可多选。')}</p>
        )}
      </div>
    ) : null;
  if (!canvas)
    return (
      <section className={`canvas-workspace ${compact ? 'compact' : ''}`} aria-label={tr('创作')}>
        <StudioHome
          canvases={state.canvases}
          busy={busy}
          error={error}
          onClose={onClose}
          onCreate={(mode) => void perform(() => create(mode))}
          onOpen={(id) =>
            void perform(async () => {
              if (owner) await api.canvasBind(owner, id);
              undo.current = [];
              redo.current = [];
              await load(id, true, true);
            })
          }
        />
      </section>
    );
  return (
    <section
      className={`canvas-workspace ${compact ? 'compact' : ''}`}
      ref={workspace}
      aria-label={tr('画布与工作流')}
      onKeyDown={(e) => {
        if (e.target instanceof Element && e.target.closest('.whiteboard-editor')) return;
        if (e.target instanceof Element && e.target.closest('[role="dialog"],.canvas-chat-float'))
          return;
        if (e.target instanceof Element && e.target.closest('input,textarea,select')) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && canvas) {
          e.preventDefault();
          select(canvas.nodes.map((n) => n.id));
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && canvas) {
          e.preventDefault();
          void perform(async () => change(duplicateSelection(canvas)));
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void perform(save);
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          history(e.shiftKey ? 'redo' : 'undo');
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          remove();
        }
      }}
    >
      {library && (
        <CanvasLibrary
          api={api}
          mode={library}
          initialText={node?.text}
          onClose={() => setLibrary(undefined)}
          onTemplate={async (id, version) => {
            await flush.current();
            const next = await api.canvasLoadTemplate(id, version);
            if (owner) await api.canvasBind(owner, next.id);
            undo.current = [];
            redo.current = [];
            await load(next.id, true);
            setNotice(tr('模板已创建。请重新选择素材、插件连接和执行会话。'));
          }}
          onPrompt={(text, title, replace) => {
            const c = current.current;
            if (!c) throw new Error(tr('请先创建画布'));
            if (replace) {
              if (c.selection.length !== 1) throw new Error(tr('请选择一个节点后填入提示词'));
              change({
                ...c,
                nodes: c.nodes.map((n) => (n.id === c.selection[0] ? { ...n, text } : n)),
              });
            } else {
              if (c.nodes.length >= 200) throw new Error(tr('画布最多支持 200 个节点'));
              const id = crypto.randomUUID();
              change({
                ...c,
                nodes: [
                  ...c.nodes,
                  {
                    id,
                    kind: 'text',
                    title,
                    text,
                    x: (c.nodes.length % 4) * 300,
                    y: Math.floor(c.nodes.length / 4) * 240,
                  },
                ],
                selection: [id],
              });
            }
          }}
        />
      )}
      <header className="canvas-toolbar">
        <button
          title={tr('返回创作')}
          aria-label={tr('返回创作')}
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await flush.current();
              home.current = true;
              homeBoundCanvas.current = boundCanvas.current;
              current.current = null;
              savedBase.current = null;
              setCanvas(null);
              setRunId('');
              setInspector(undefined);
              setSettingsOpen(false);
              setLibrary(undefined);
              setNotice('');
              await load();
            })
          }
        >
          <ArrowLeft size={15} />
        </button>
        <select
          aria-label={tr('选择画布')}
          value={canvas?.id ?? ''}
          disabled={busy}
          onChange={(e) => {
            const nextCanvasId = e.currentTarget.value;
            void perform(async () => {
              if (dirtyRef.current) await save();
              undo.current = [];
              redo.current = [];
              if (owner && nextCanvasId) await api.canvasBind(owner, nextCanvasId);
              await load(nextCanvasId || undefined, true);
            });
          }}
        >
          <option value="">{tr('选择画布')}</option>
          {state.canvases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.mode === 'whiteboard' ? tr('白板') + ' · ' : ''}
              {c.title}
            </option>
          ))}
        </select>
        <button
          title={tr('新建画布')}
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              if (dirtyRef.current) await save();
              await create();
            })
          }
        >
          <Plus size={14} />
          {tr('新建')}
        </button>
        <button
          title={tr('新建白板')}
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await flush.current();
              await create('whiteboard');
            })
          }
        >
          <Plus size={14} />
          {tr('白板')}
        </button>
        {canvas && (
          <>
            <button disabled={busy || !dirty} onClick={() => void perform(save)}>
              <Save size={14} />
              {dirty ? tr('保存') : tr('已保存')}
            </button>
            <small className="canvas-save-status" role="status">
              {saveStatus === 'saving'
                ? tr('保存中…')
                : saveStatus === 'failed'
                  ? tr('保存失败，请重试')
                  : dirty
                    ? draftStatus === 'stored'
                      ? tr('草稿已暂存，尚未保存')
                      : draftStatus === 'failed'
                        ? tr('草稿暂存失败，请保存')
                        : tr('有未保存修改')
                    : ''}
            </small>
            <button
              title={tr('复制画布')}
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const source = dirtyRef.current ? await save() : canvas;
                  if (!source) return;
                  const { id: _, version: _v, updatedAt: _t, ...definition } = source;
                  const next = await api.canvasSave({
                    ...definition,
                    title: source.title + tr(' · 副本'),
                  });
                  if (owner) await api.canvasBind(owner, next.id);
                  await load(next.id, true);
                })
              }
            >
              <Copy size={14} />
            </button>
            <span className="canvas-version">v{canvas.version}</span>
          </>
        )}
        {canvas?.mode !== 'whiteboard' && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (dirtyRef.current) await flush.current();
                  const next = await api.canvasImport();
                  if (next) {
                    if (owner) await api.canvasBind(owner, next.id);
                    undo.current = [];
                    redo.current = [];
                    await load(next.id, true);
                    setNotice(tr('已导入。请重新选择模型／插件连接，并检查素材和输出位置。'));
                  }
                })
              }
            >
              {tr('导入')}
            </button>
            <select
              aria-label={tr('导出画布')}
              value=""
              disabled={busy || !canvas}
              onChange={(e) => {
                const mode = e.target.value as 'template' | 'project';
                if (mode)
                  void perform(async () => {
                    await flush.current();
                    const c = current.current!;
                    const path = await api.canvasExport(c.id, c.version, mode);
                    if (path) setNotice(tr('已导出到：') + path);
                  });
              }}
            >
              <option value="">{tr('导出…')}</option>
              <option value="template">{tr('工作流模板 JSON')}</option>
              <option value="project">{tr('项目 JSON（含素材与结果）')}</option>
            </select>
            <button
              disabled={busy || !canvas}
              onClick={() =>
                void perform(async () => {
                  await flush.current();
                  const c = current.current!;
                  await api.canvasSaveTemplate(c.id, c.version);
                  setNotice(tr('已保存到内容库的“画布模板”目录。'));
                })
              }
            >
              {tr('保存为模板')}
            </button>
            <button onClick={() => setLibrary('template')}>{tr('模板库')}</button>
            <button onClick={() => setLibrary('prompt')} disabled={!canvas}>
              {tr('提示词库')}
            </button>
          </>
        )}
        {canvas?.mode === 'whiteboard' && (
          <button disabled={busy} onClick={importWhiteboard}>
            {tr('导入白板')}
          </button>
        )}
        <span className="canvas-toolbar-spacer" />
        <button
          aria-label={tr('切换画布聊天')}
          aria-pressed={chatOpen}
          onClick={() => setChatOpen((v) => !v)}
        >
          <MessageSquare size={15} />
          {tr(' 聊天')}
        </button>
        <button
          aria-label={tr('画布设置')}
          disabled={busy || !canvas}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 size={15} />
          {tr(' 画布设置')}
        </button>
        {onClose && (
          <button
            aria-label={tr('关闭画布')}
            onClick={() => {
              if (dirty)
                void perform(async () => {
                  await save();
                  onClose();
                });
              else onClose();
            }}
          >
            <X size={15} />
          </button>
        )}
      </header>
      {notice && (
        <div className="canvas-notice" role="status">
          {notice}
          <button aria-label={tr('关闭提示')} onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      {error && (
        <div className="canvas-alert" role="alert">
          {error}
          <button onClick={() => void perform(() => load(canvas?.id, true))}>
            {tr('重新载入')}
          </button>
        </div>
      )}
      {conflict && (
        <div className="canvas-alert" role="alert">
          {tr('你和 AI／其他窗口修改了同一处内容，已暂停同步。')}
          <button
            onClick={() =>
              void perform(async () => {
                const id = current.current?.id;
                await load(id, true);
                if (id) localStorage.removeItem(draftKey(id));
                setNotice(tr('已采用最新版本，可以继续编辑和对话。'));
              })
            }
          >
            {tr('使用最新版本')}
          </button>
          <button
            onClick={() => {
              const local = current.current;
              if (!local) return;
              savedBase.current = conflict;
              change({ ...local, version: conflict.version });
              conflictRef.current = undefined;
              setConflict(undefined);
              setNotice(tr('已保留本地草稿；保存后将覆盖该版本的远端修改。'));
            }}
          >
            {tr('保留本地草稿')}
          </button>
        </div>
      )}
      {canvas && canvas.mode !== 'whiteboard' && (
        <div className="canvas-actionbar">
          <button
            title={tr('撤销')}
            disabled={!undo.current.length}
            onClick={() => history('undo')}
          >
            <Undo2 size={14} />
          </button>
          <button
            title={tr('重做')}
            disabled={!redo.current.length}
            onClick={() => history('redo')}
          >
            <Redo2 size={14} />
          </button>
          <button
            title={tr('移除所选节点')}
            disabled={!canvas.selection.length}
            onClick={() => remove()}
          >
            <Trash2 size={14} />
          </button>
          {canvas.selection.length > 1 && (
            <button
              disabled={!canvas.selection.length}
              onClick={() => void perform(async () => change(duplicateSelection(canvas)))}
            >
              {tr('复制选中')}
            </button>
          )}
          {canvas.selection.length > 1 && (
            <select
              aria-label={tr('批量操作')}
              value=""
              disabled={!canvas.selection.length}
              onChange={(e) => {
                const action = e.target.value;
                if (action === 'group' || action === 'ungroup') {
                  const group =
                    action === 'group'
                      ? tr('分组 {0}', [crypto.randomUUID().slice(0, 8)])
                      : undefined;
                  change({
                    ...canvas,
                    nodes: canvas.nodes.map((n) =>
                      canvas.selection.includes(n.id) ? { ...n, group } : n,
                    ),
                  });
                } else if (action)
                  change(alignSelection(canvas, action as 'left' | 'top' | 'horizontal'));
              }}
            >
              <option value="">{tr('批量操作')}</option>
              <option value="group">{tr('编组')}</option>
              <option value="ungroup">{tr('取消编组')}</option>
              <option value="left">{tr('左对齐')}</option>
              <option value="top">{tr('顶对齐')}</option>
              <option value="horizontal">{tr('水平分布')}</option>
            </select>
          )}
          <span className="canvas-toolbar-spacer" />
          {activeRun ? (
            <button
              disabled={busy}
              onClick={() => void perform(() => api.canvasCancel(activeRun.id))}
            >
              <Square size={13} />
              {tr('停止')}
            </button>
          ) : (
            <>
              <button
                disabled={busy || readOnly || !canvas.selection.length}
                onClick={() => execute(true)}
              >
                {tr('运行选中节点')}
              </button>
              <button
                className="primary"
                disabled={busy || readOnly || !canvas.nodes.length}
                onClick={() => execute()}
              >
                <Play size={13} />
                {tr('运行整个流程')}
              </button>
            </>
          )}
        </div>
      )}
      <div className="canvas-body">
        {canvas.mode === 'whiteboard' ? (
          <Suspense fallback={<div className="canvas-welcome">{tr('加载白板…')}</div>}>
            <WhiteboardBoard
              key={canvas.id}
              canvas={canvas}
              api={api}
              onChange={change}
              onError={(e) => setError(errorMessage(e))}
              onImport={importWhiteboard}
              onSave={() => void perform(() => flush.current())}
              blocked={!!conflict}
            />
          </Suspense>
        ) : (
          <>
            <CanvasNodePalette
              plugins={state.plugins ?? []}
              disabled={busy || !!conflict}
              onAdd={addFromPalette}
            />
            <CanvasBoard
              mediaControls={{
                data,
                composerTarget,
                edit: () => {
                  setConfigOpen(true);
                },
                dismiss: () => setConfigOpen(false),
                disabled: busy || !!activeRun || readOnly || !!conflict,
                hideComposer: !!inspector || settingsOpen || !!mediaHistory,
                history: (id) => {
                  setMediaHistory(id);
                  setHistoryRunId('');
                },
                sourceCanvas: shownRun?.definition,
                previousSteps: Object.fromEntries(
                  canvas.nodes.flatMap((n) => {
                    const step = state.runs
                      .filter((r) => r.id !== shownRun?.id)
                      .map((r) => r.nodes[n.id])
                      .find(
                        (s) =>
                          s?.generation?.some((item) => item.resources.length) ||
                          s?.output?.resources.length,
                      );
                    return step ? [[n.id, step]] : [];
                  }),
                ),
                executionIssue: !owner
                  ? tr('请在画布设置中选择执行会话')
                  : readOnly
                    ? tr('当前会话为只读模式')
                    : undefined,
                generate: (id) => execute(false, id),
                retry: regenerate,
              }}
              onAddNode={addFromPalette}
              onError={(e) => setError(errorMessage(e))}
              plugins={state.plugins}
              api={api}
              canvas={canvas}
              steps={shownRun?.nodes ?? {}}
              onChange={change}
              onSelect={select}
              onRemove={remove}
              onConfigure={(id) => {
                select([id]);
                setInspector(id);
              }}
            />
          </>
        )}
        {settingsOpen && (
          <Modal title={tr('画布设置')} onClose={() => setSettingsOpen(false)}>
            <div className="canvas-inspector canvas-config-form">
              <label>
                {tr('画布名称')}
                <input
                  value={canvas.title}
                  onChange={(e) => change({ ...canvas, title: e.target.value })}
                />
              </label>
              <label>
                {tr('画布会话')}
                <select
                  aria-label={tr('画布会话')}
                  value={owner}
                  disabled={busy || !!activeRun}
                  onChange={(e) => void perform(() => bindOwner(e.target.value))}
                >
                  <option value="">{tr('请选择')}</option>
                  {data.sessions
                    .filter((s) => isUserSession(s) && !s.archived)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                </select>
              </label>
              {canvas.mode !== 'whiteboard' && (
                <>
                  <label className="canvas-check">
                    <input
                      type="checkbox"
                      checked={reuse}
                      onChange={(e) => setReuse(e.target.checked)}
                    />
                    {tr('复用输入未变化的结果')}
                  </label>
                  <small>
                    {tr(
                      '节点沿用执行会话的模型、思考设置、工具与权限。媒体节点需选择对应生成插件。',
                    )}
                  </small>
                  <h3>{tr('执行记录')}</h3>
                  <select
                    aria-label={tr('执行记录')}
                    value={shownRun?.id ?? ''}
                    onChange={(e) => setRunId(e.target.value)}
                  >
                    <option value="">{tr('暂无记录')}</option>
                    {state.runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {new Date(r.startedAt).toLocaleString(getLocale())} · v
                        {r.definition.version} ·{' '}
                        {
                          {
                            running: tr('运行中'),
                            completed: tr('已完成'),
                            failed: tr('失败'),
                            cancelled: tr('已停止'),
                            interrupted: tr('已中断'),
                          }[r.status]
                        }
                      </option>
                    ))}
                  </select>
                  {shownRun?.error && <p role="alert">{shownRun.error}</p>}
                </>
              )}
            </div>
          </Modal>
        )}
        {inspector && node && (
          <Modal
            title={tr('节点配置')}
            subtitle={node.title}
            onClose={() => setInspector(undefined)}
          >
            {nodeConfiguration}
          </Modal>
        )}
        {mediaHistory && (
          <Modal
            title={tr('生成历史')}
            subtitle={canvas.nodes.find((n) => n.id === mediaHistory)?.title}
            onClose={() => setMediaHistory(undefined)}
          >
            <div className="canvas-inspector canvas-config-form">
              <label>
                {tr('历史版本')}
                <select
                  aria-label={tr('历史版本')}
                  value={mediaHistoryRun?.id ?? ''}
                  onChange={(e) => setHistoryRunId(e.target.value)}
                >
                  {!mediaHistoryRuns.length && <option value="">{tr('暂无记录')}</option>}
                  {mediaHistoryRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      {new Date(r.startedAt).toLocaleString(getLocale())} · v{r.definition.version}
                    </option>
                  ))}
                </select>
              </label>
              {mediaHistoryRun && (
                <CanvasMediaResults
                  api={api}
                  step={mediaHistoryRun.nodes[mediaHistory]}
                  disabled
                  historyOnly
                  onRegenerate={() => {}}
                  onError={(e) => setError(errorMessage(e))}
                  previewKey={`tongzhou.canvas.history.${canvas.id}.${mediaHistory}.${mediaHistoryRun.id}`}
                />
              )}
            </div>
          </Modal>
        )}
        <div
          className="canvas-chat-float"
          data-config-open={showConfig}
          data-chat-open={chatOpen}
          hidden={!chatOpen && !showConfig}
        >
          <section className="canvas-panel-config" aria-label={tr('节点配置')} hidden={!showConfig}>
            {showConfig && !inlineMedia && !inspector && node && (
              <>
                <div className="canvas-node-config-heading">
                  <strong title={node.title}>{node.title}</strong>
                  <button
                    className="icon-button"
                    aria-label={tr('收起节点配置')}
                    onClick={() => setConfigOpen(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="canvas-node-config-fields" key={node.id}>
                  {nodeConfiguration}
                </div>
              </>
            )}
            <div ref={setComposerTarget} className="canvas-node-config-outlet" />
          </section>
          <div className="canvas-panel-pane" hidden={!chatOpen}>
            <CanvasAssistant
              key={canvas.id}
              open={chatOpen}
              workflowRuns={state.runs}
              api={api}
              canvas={canvas}
              session={ownerSession}
              data={data}
              blocked={!!conflict}
              onPrepare={async () => {
                validateConfig();
                await load(current.current?.id);
                await flush.current();
              }}
              onOpenSettings={() => setSettingsOpen(true)}
              onCollapse={() => setChatOpen(false)}
              onCreate={createChat}
              onSession={onSession}
              onInsert={(message, replace) => {
                void perform(async () => {
                  const c = current.current!;
                  if (replace && c.selection.length !== 1) throw new Error(tr('请选择一个节点'));
                  const selected = c.nodes.find((n) => n.id === c.selection[0]);
                  if (!message.artifactIds?.length && message.content.length > 32000)
                    throw new Error(tr('回答超过节点上限，请先拆分内容'));
                  if ((message.artifactIds?.length ?? 0) > 8)
                    throw new Error(tr('回答包含超过 8 个产物，请通过资源选择器分批插入'));
                  if (replace && (message.artifactIds?.length ?? 0) > 1)
                    throw new Error(tr('多个产物请使用插入画布，或单独选择一个产物替换'));
                  const items: CanvasNode[] = message.artifactIds?.length
                    ? message.artifactIds.slice(0, 8).map((id, i) => ({
                        id: crypto.randomUUID(),
                        kind: 'resource',
                        title: tr('助手产物 {0}', [i + 1]),
                        x: (selected?.x ?? 0) + 300 + i * 280,
                        y: selected?.y ?? 0,
                        resource: { kind: 'artifact', id },
                      }))
                    : [
                        {
                          id: crypto.randomUUID(),
                          kind: 'text',
                          title: tr('助手建议'),
                          text: message.content,
                          x: (selected?.x ?? 0) + 300,
                          y: selected?.y ?? 0,
                        },
                      ];
                  if (replace && selected) {
                    const first = items[0];
                    change({
                      ...c,
                      nodes: c.nodes.map((n) =>
                        n.id !== selected.id
                          ? n
                          : first.kind === 'text'
                            ? { ...n, text: first.text }
                            : { ...first, id: n.id, x: n.x, y: n.y, group: n.group },
                      ),
                    });
                  } else {
                    if (c.nodes.length + items.length > 200)
                      throw new Error(tr('画布最多支持 200 个节点'));
                    change({
                      ...c,
                      nodes: [...c.nodes, ...items],
                      selection: items.map((n) => n.id),
                    });
                  }
                });
              }}
            />
          </div>
        </div>
        {!chatOpen && (
          <button
            className="canvas-chat-launcher"
            aria-label={tr('展开画布聊天')}
            title={tr('AI 助手')}
            aria-expanded={false}
            onClick={() => setChatOpen(true)}
          >
            <MessageSquare size={22} />
          </button>
        )}
      </div>
      {canvas && canvas.mode !== 'whiteboard' && (
        <footer className="canvas-footer">
          {canvas.nodes.length}
          {tr(' 个节点 · ')}
          {canvas.edges.length}
          {tr(' 条连线')}
          <span>
            {tr('右键配置节点 · Shift 框选 · ⌘/Ctrl A 全选 · ⌘/Ctrl D 复制 · ⌘/Ctrl S 保存')}
          </span>
        </footer>
      )}
      {picker && (
        <CanvasSourcePicker
          api={api}
          data={data}
          imageOnly={
            picker === 'replace' &&
            state.plugins?.find((p) => p.id === node?.pluginId)?.view?.resource === 'image'
          }
          sessionId={owner}
          onClose={() => {
            setPicker(false);
            resourceDrop.current = undefined;
          }}
          onSelect={(title, resource) => {
            if (picker === 'replace' && node)
              patch({ resource, ...(node.kind === 'resource' ? { title } : {}) });
            else add('resource', title, resource, undefined, resourceDrop.current);
            resourceDrop.current = undefined;
            setPicker(false);
          }}
        />
      )}
    </section>
  );
}

const canvasNodeKinds = localized(raw_canvasNodeKinds);
