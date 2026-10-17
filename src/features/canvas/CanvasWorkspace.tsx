import {
  CanvasMediaFields,
  CanvasMediaResults,
  CanvasOutputLocation,
  CanvasResourceOutput,
} from './CanvasMedia';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  PanelRightClose,
} from 'lucide-react';
import type {
  Canvas,
  CanvasNode,
  CanvasNodeKind,
  CanvasResource,
  CanvasState,
} from '../../shared/canvas';
import { canvasNodeKinds } from '../../shared/canvas';
import type { Session, Snapshot, TongzhouAPI } from '../../shared/types';
import { effectivePermission } from '../../shared/permissions';
import { isUserSession } from '../../shared/session-scope';
import { CanvasBoard } from './CanvasBoard';
import { CanvasSourcePicker } from './CanvasSourcePicker';
import { CanvasPluginFields } from './CanvasPluginFields';
import { errorMessage } from '../../lib/feedback';
import './canvas.css';

export function CanvasWorkspace({
  api,
  data,
  sessionId,
  onSession,
  onClose,
  compact = false,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  sessionId?: string;
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
    [inspector, setInspector] = useState(!compact),
    [kind, setKind] = useState<string>('text'),
    [target, setTarget] = useState(''),
    [edgeKind, setEdgeKind] = useState<'dependency' | 'reference'>('dependency'),
    [reuse, setReuse] = useState(true),
    [owner, setOwner] = useState(sessionId ?? ''),
    [runId, setRunId] = useState('');
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>([
    { id: 'default', name: '我的内容' },
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
  const workspace = useRef<HTMLElement>(null);
  const validateConfig = () => {
    const invalid = workspace.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '.canvas-inspector input:invalid,.canvas-inspector textarea:invalid',
    );
    if (invalid) {
      invalid.reportValidity();
      throw new Error('请检查节点插件的扩展参数');
    }
  };
  const boundCanvas = useRef<string | undefined>(undefined);
  boundCanvas.current = data.sessions.find((s) => s.id === owner)?.activeCanvasId;
  const current = useRef(canvas),
    dirtyRef = useRef(dirty),
    request = useRef(0),
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
        } catch {
          /* The explicit save action remains available if browser storage is full. */
        }
    };
    const timer = setTimeout(persistDraft, 400);
    return () => {
      clearTimeout(timer);
      persistDraft();
    };
  }, [canvas, dirty]);
  const load = useCallback(
    async (id?: string, force = false, restoreDraft = false) => {
      const seq = ++request.current,
        result = await api.canvasState(id);
      if (seq !== request.current) return;
      setState(result);
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
            } else if (draft) setError('画布已有新版本，本地草稿仍保留；请先核对当前内容。');
          } catch {
            /* Ignore malformed browser drafts. */
          }
        current.current = next;
        dirtyRef.current = restored;
        setCanvas(next);
        setDirty(restored);
      }
    },
    [api],
  );
  useEffect(() => {
    void load(data.sessions.find((s) => s.id === sessionId)?.activeCanvasId, true, true).catch(
      (e) => setError(errorMessage(e)),
    );
  }, [api, sessionId]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onEvent((e) => {
      if (e.type !== 'changed') return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void load(current.current?.id ?? boundCanvas.current).catch((e) =>
          setError(errorMessage(e)),
        );
      }, 180);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [api, load]);
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
    },
    [change],
  );
  const activeRun = state.runs.find((r) => r.status === 'running'),
    shownRun = state.runs.find((r) => r.id === runId) ?? state.runs[0];
  const node = canvas?.nodes.find((n) => n.id === canvas.selection[0]);
  const ownerSession = data.sessions.find((s) => s.id === owner),
    readOnly =
      effectivePermission(
        ownerSession,
        data.defaultPermission,
        data.agents.find((a) => a.id === ownerSession?.agentId),
      ) === 'read-only';
  const save = async () => {
    const c = current.current;
    if (!c) return;
    const { updatedAt: _, ...input } = c,
      next = await api.canvasSave(input);
    localStorage.removeItem(draftKey(c.id));
    if (current.current !== c && current.current?.id === c.id) {
      const edited = { ...current.current, version: next.version };
      current.current = edited;
      setCanvas(edited);
      setDirty(true);
      return next;
    }
    current.current = next;
    dirtyRef.current = false;
    setCanvas(next);
    setDirty(false);
    if (owner) await api.canvasBind(owner, next.id);
    await load(next.id);
    return next;
  };
  const create = async () => {
    const next = await api.canvasSave({
      title: '未命名画布',
      nodes: [],
      edges: [],
      selection: [],
      viewport: { x: 40, y: 40, zoom: 1 },
    });
    if (owner) await api.canvasBind(owner, next.id);
    undo.current = [];
    redo.current = [];
    await load(next.id, true);
  };
  const add = (
    type: CanvasNodeKind,
    title?: string,
    resource?: CanvasResource,
    pluginId?: string,
  ) => {
    const c = current.current;
    if (!c) return;
    const id = crypto.randomUUID(),
      i = c.nodes.length;
    change({
      ...c,
      nodes: [
        ...c.nodes,
        {
          id,
          kind: type,
          ...(pluginId ? { pluginId } : {}),
          title: title ?? canvasNodeKinds[type],
          x: (i % 4) * 300,
          y: Math.floor(i / 4) * 240,
          ...(resource ? { resource } : {}),
          ...(type === 'save' ? { libraryId: 'default' } : {}),
          ...(['image', 'video'].includes(type)
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
    setInspector(true);
  };
  const patch = (patch: Partial<CanvasNode>) => {
    if (canvas && node)
      change({
        ...canvas,
        nodes: canvas.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)),
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
  const remove = () => {
    if (canvas)
      change({
        ...canvas,
        nodes: canvas.nodes.filter((n) => !canvas.selection.includes(n.id)),
        edges: canvas.edges.filter(
          (e) => !canvas.selection.includes(e.from) && !canvas.selection.includes(e.to),
        ),
        selection: [],
      });
  };
  const execute = (selected = false) =>
    void perform(async () => {
      validateConfig();
      if (!owner) throw new Error('请选择执行会话');
      const c = dirtyRef.current ? await save() : current.current;
      if (!c) return;
      const r = await api.canvasExecute({
        canvasId: c.id,
        version: c.version,
        sessionId: owner,
        nodeIds: selected ? c.selection : undefined,
        reuse,
      });
      setRunId(r.id);
      await load(c.id);
    });
  const saveReferenced = () =>
    void perform(async () => {
      if (!owner || !node) throw new Error('请选择执行会话和图片节点');
      const c = dirtyRef.current ? await save() : current.current;
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
      if (!owner) throw new Error('请选择执行会话');
      const c = dirtyRef.current ? await save() : current.current;
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
  return (
    <section
      className={`canvas-workspace ${compact ? 'compact' : ''}`}
      ref={workspace}
      aria-label="画布与工作流"
      onKeyDown={(e) => {
        if (e.target instanceof Element && e.target.closest('input,textarea,select')) return;
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
      <header className="canvas-toolbar">
        <select
          aria-label="选择画布"
          value={canvas?.id ?? ''}
          disabled={busy}
          onChange={(e) =>
            void perform(async () => {
              if (dirtyRef.current) await save();
              undo.current = [];
              redo.current = [];
              if (owner && e.target.value) await api.canvasBind(owner, e.target.value);
              await load(e.target.value || undefined, true);
            })
          }
        >
          <option value="">选择画布</option>
          {state.canvases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button
          title="新建画布"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              if (dirtyRef.current) await save();
              await create();
            })
          }
        >
          <Plus size={14} />
          新建
        </button>
        {canvas && (
          <>
            <button disabled={busy || !dirty} onClick={() => void perform(save)}>
              <Save size={14} />
              {dirty ? '保存' : '已保存'}
            </button>
            <button
              title="另存为工作流模板"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const source = dirtyRef.current ? await save() : canvas;
                  if (!source) return;
                  const { id: _, version: _v, updatedAt: _t, ...definition } = source;
                  const next = await api.canvasSave({
                    ...definition,
                    title: source.title + ' · 副本',
                  });
                  if (owner) await api.canvasBind(owner, next.id);
                  await load(next.id, true);
                })
              }
            >
              <Copy size={14} />
            </button>
            <span className="canvas-version">
              v{canvas.version}
              {dirty ? ' · 未保存' : ''}
            </span>
          </>
        )}
        <span className="canvas-toolbar-spacer" />
        <button
          aria-label="切换节点配置"
          aria-pressed={inspector}
          onClick={() => setInspector((v) => !v)}
        >
          <PanelRightClose size={15} />
        </button>
        {onClose && (
          <button
            aria-label="关闭画布"
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
      {error && (
        <div className="canvas-alert" role="alert">
          {error}
          <button onClick={() => void perform(() => load(canvas?.id, true))}>重新载入</button>
        </div>
      )}
      {canvas && (
        <div className="canvas-actionbar">
          <select aria-label="节点类型" value={kind} onChange={(e) => setKind(e.target.value)}>
            {(
              state.plugins ?? Object.entries(canvasNodeKinds).map(([id, name]) => ({ id, name }))
            ).map((plugin) => (
              <option key={plugin.id} value={plugin.id}>
                {plugin.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              const plugin = state.plugins?.find((p) => p.id === kind);
              if (kind === 'resource') setPicker('add');
              else
                add(plugin?.kind ?? (kind as CanvasNodeKind), plugin?.name, undefined, plugin?.id);
            }}
          >
            <Plus size={13} />
            添加节点
          </button>
          <button title="撤销" disabled={!undo.current.length} onClick={() => history('undo')}>
            <Undo2 size={14} />
          </button>
          <button title="重做" disabled={!redo.current.length} onClick={() => history('redo')}>
            <Redo2 size={14} />
          </button>
          <button title="移除所选节点" disabled={!canvas.selection.length} onClick={remove}>
            <Trash2 size={14} />
          </button>
          <span className="canvas-toolbar-spacer" />
          {activeRun ? (
            <button
              disabled={busy}
              onClick={() => void perform(() => api.canvasCancel(activeRun.id))}
            >
              <Square size={13} />
              停止
            </button>
          ) : (
            <>
              <button
                disabled={busy || readOnly || !canvas.selection.length}
                onClick={() => execute(true)}
              >
                运行选中
              </button>
              <button
                className="primary"
                disabled={busy || readOnly || !canvas.nodes.length}
                onClick={() => execute()}
              >
                <Play size={13} />
                运行
              </button>
            </>
          )}
        </div>
      )}
      {!canvas ? (
        <div className="canvas-welcome">
          <h2>画布</h2>
          <p>组织资料、连接能力、保存并执行工作流。</p>
          <button className="primary" disabled={busy} onClick={() => void perform(create)}>
            <Plus size={15} />
            创建画布
          </button>
        </div>
      ) : (
        <div className="canvas-body">
          <CanvasBoard
            api={api}
            canvas={canvas}
            steps={shownRun?.nodes ?? {}}
            onChange={change}
            onSelect={select}
            onConfigure={(id) => {
              select([id]);
              setInspector(true);
            }}
          />
          {inspector && (
            <aside className="canvas-inspector" aria-label="节点与执行配置">
              <label>
                画布名称
                <input
                  value={canvas.title}
                  onChange={(e) => change({ ...canvas, title: e.target.value })}
                />
              </label>
              <label>
                执行会话
                <select
                  aria-label="执行会话"
                  value={owner}
                  onChange={(e) => {
                    setOwner(e.target.value);
                    if (e.target.value)
                      void perform(() => api.canvasBind(e.target.value, canvas.id));
                  }}
                >
                  <option value="">请选择</option>
                  {data.sessions
                    .filter((s) => isUserSession(s) && !s.archived)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                </select>
              </label>
              <label className="canvas-check">
                <input
                  type="checkbox"
                  checked={reuse}
                  onChange={(e) => setReuse(e.target.checked)}
                />
                复用输入未变化的结果
              </label>
              <small>
                节点沿用执行会话的模型、思考设置、工具与权限。图片节点需可用的生图工具。
              </small>
              {node ? (
                <>
                  <h3>
                    {state.plugins?.find((p) => p.id === (node.pluginId ?? node.kind))?.name ??
                      canvasNodeKinds[node.kind]}
                  </h3>
                  <label>
                    节点名称
                    <input value={node.title} onChange={(e) => patch({ title: e.target.value })} />
                  </label>
                  {['image', 'video'].includes(node.kind) && (
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
                        自定义提示词
                        <textarea
                          aria-label="自定义提示词"
                          rows={3}
                          value={node.text ?? ''}
                          placeholder="补充生成要求，随引用内容传给下游图片或视频节点"
                          onChange={(e) => patch({ text: e.target.value })}
                        />
                      </label>
                      <button onClick={() => setPicker('replace')}>更换引用资源</button>
                      <small>
                        {node.resource
                          ? {
                              content: '内容库',
                              artifact: '会话作品',
                              message: '会话消息',
                              file: '项目文件',
                            }[node.resource.kind]
                          : '尚未选择资源'}
                        {node.resource?.kind === 'content'
                          ? ' · v' + node.resource.version
                          : node.resource?.kind === 'file'
                            ? ' · ' + node.resource.path
                            : ''}
                      </small>
                    </>
                  ) : (
                    node.kind !== 'save' && (
                      <label>
                        {node.kind === 'text'
                          ? '正文'
                          : ['image', 'video'].includes(node.kind)
                            ? '生成提示词'
                            : '处理要求'}
                        <textarea
                          value={node.text ?? ''}
                          rows={5}
                          onChange={(e) => patch({ text: e.target.value })}
                        />
                      </label>
                    )
                  )}
                  {node.kind === 'plugin' && (
                    <CanvasPluginFields
                      data={data}
                      definition={state.plugins?.find((p) => p.id === (node.pluginId ?? node.kind))}
                      node={node}
                      patch={patch}
                    />
                  )}
                  {node.kind === 'agent' && (
                    <>
                      <label>
                        模型连接
                        <select
                          value={node.providerId ?? ''}
                          onChange={(e) =>
                            patch({
                              providerId: e.target.value || undefined,
                              model: data.providers.find((p) => p.id === e.target.value)?.models[0],
                            })
                          }
                        >
                          <option value="">跟随执行会话</option>
                          {data.providers
                            .filter((p) => p.enabled !== false)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        模型
                        <select
                          value={node.model ?? ''}
                          onChange={(e) => patch({ model: e.target.value || undefined })}
                        >
                          <option value="">跟随执行会话</option>
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
                          <option value="">跟随执行会话</option>
                          {data.agents
                            .filter(
                              (a) => !['knowledge-organizer', 'memory-organizer'].includes(a.id),
                            )
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    </>
                  )}
                  {['image', 'video'].includes(node.kind) && (
                    <CanvasMediaFields
                      api={api}
                      data={data}
                      node={node}
                      patch={patch}
                      onError={(e) => setError(errorMessage(e))}
                    />
                  )}
                  {node.kind === 'save' && (
                    <label>
                      目标内容库
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
                  <h3>连线</h3>
                  <div className="canvas-connect">
                    <select
                      aria-label="连线类型"
                      value={edgeKind}
                      onChange={(e) => setEdgeKind(e.target.value as typeof edgeKind)}
                    >
                      <option value="dependency">执行依赖 →</option>
                      <option value="reference">资料引用 ⇢</option>
                    </select>
                    <select
                      aria-label="目标节点"
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      <option value="">选择目标</option>
                      {canvas.nodes
                        .filter((n) => n.id !== node.id)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.title}
                          </option>
                        ))}
                    </select>
                    <button
                      disabled={!target}
                      onClick={() => {
                        change({
                          ...canvas,
                          edges: [
                            ...canvas.edges,
                            { id: crypto.randomUUID(), from: node.id, to: target, kind: edgeKind },
                          ],
                        });
                        setTarget('');
                      }}
                    >
                      连接
                    </button>
                  </div>
                  {canvas.edges
                    .filter((e) => e.from === node.id || e.to === node.id)
                    .map((e) => (
                      <div className="canvas-edge-row" key={e.id}>
                        <span>
                          {e.from === node.id ? '→ ' : '← '}
                          {
                            canvas.nodes.find((n) => n.id === (e.from === node.id ? e.to : e.from))
                              ?.title
                          }
                          <small>{e.kind === 'dependency' ? '执行依赖' : '引用'}</small>
                        </span>
                        <button
                          aria-label="删除连线"
                          onClick={() =>
                            change({ ...canvas, edges: canvas.edges.filter((v) => v.id !== e.id) })
                          }
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  {['image', 'video'].includes(node.kind) && node.media?.mode !== 'existing' && (
                    <>
                      <button
                        className="primary"
                        disabled={busy || !!activeRun || readOnly}
                        onClick={() => regenerate(node.id)}
                      >
                        生成{node.kind === 'image' ? '图片' : '视频'} · {node.media?.count ?? 1}
                        {node.kind === 'image' ? '张' : '条'}
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
                  {shownRun?.nodes[node.id] && !['image', 'video'].includes(node.kind) && (
                    <>
                      <h3>所选运行结果</h3>
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
                          查看执行过程／处理审批
                        </button>
                      )}
                    </>
                  )}
                </>
              ) : (
                <p>选中节点以编辑；Shift 点击可多选。</p>
              )}
              <h3>执行记录</h3>
              <select
                aria-label="执行记录"
                value={shownRun?.id ?? ''}
                onChange={(e) => setRunId(e.target.value)}
              >
                <option value="">暂无记录</option>
                {state.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.startedAt).toLocaleString()} · v{r.definition.version} ·{' '}
                    {
                      {
                        running: '运行中',
                        completed: '已完成',
                        failed: '失败',
                        cancelled: '已停止',
                        interrupted: '已中断',
                      }[r.status]
                    }
                  </option>
                ))}
              </select>
              {shownRun?.error && <p role="alert">{shownRun.error}</p>}
            </aside>
          )}
        </div>
      )}
      {canvas && (
        <footer className="canvas-footer">
          {canvas.nodes.length} 个节点 · {canvas.edges.length} 条连线
          <span>实线：执行依赖　虚线：资料引用 · ⌘/Ctrl S 保存</span>
        </footer>
      )}
      {picker && (
        <CanvasSourcePicker
          api={api}
          data={data}
          sessionId={owner}
          onClose={() => setPicker(false)}
          onSelect={(title, resource) => {
            if (picker === 'replace' && node?.kind === 'resource') patch({ resource, title });
            else add('resource', title, resource);
            setPicker(false);
          }}
        />
      )}
    </section>
  );
}
