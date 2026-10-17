import { Minus, Settings2, Check, LoaderCircle, AlertCircle, ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canvasChatTurns, canvasChatError, canvasToolLabels } from '../../shared/canvas-chat';
import type { Canvas, CanvasRun } from '../../shared/canvas';
import type { Message, PermissionMode, Session, Snapshot, TongzhouAPI } from '../../shared/types';
import { effectivePermission, permissionLabels } from '../../shared/permissions';
import { canvasChatPrompt, canvasChatUserText } from '../../shared/canvas-collaboration';
import { isUserSession } from '../../shared/session-scope';
import { errorMessage } from '../../lib/feedback';
import { Markdown } from '../../components/markdown/RichMarkdown';
import { ApprovalQueue } from '../chat/ApprovalQueue';
import { useRunEvents } from '../chat/RunActivity';
import { ResourceThumbnail } from './CanvasBoard';

export function CanvasAssistant({
  api,
  canvas,
  session,
  data,
  blocked,
  onPrepare,
  onBind,
  onCreate,
  onInsert,
  onSession,
  onCollapse,
  open,
  workflowRuns,
}: {
  api: TongzhouAPI;
  canvas: Canvas;
  session?: Session;
  data: Snapshot;
  blocked: boolean;
  onPrepare(): Promise<void>;
  onBind(id: string): Promise<void>;
  onCreate(): Promise<void>;
  onInsert(message: Message, replace: boolean): void;
  onSession(s: Session): void;
  onCollapse(): void;
  open: boolean;
  workflowRuns: CanvasRun[];
}) {
  const [prompt, setPrompt] = useState(''),
    [messages, setMessages] = useState<Message[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [hasEarlier, setHasEarlier] = useState(false),
    [pendingRun, setPendingRun] = useState(''),
    [settingsOpen, setSettingsOpen] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const carryDraft = useRef<string | undefined>(undefined);
  const draggingFeed = useRef(false);
  const feed = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    sending = useRef(false);
  const identity = `${canvas.id}:${session?.id ?? ''}`;
  const agent = data.agents.find((a) => a.id === session?.agentId);
  const permission = effectivePermission(session, 'full-access', agent);
  const readOnly = permission === 'read-only';
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const running = data.runs.find((r) => r.sessionId === session?.id && r.status === 'running');
  const working = !!running || !!pendingRun;
  const { events } = useRunEvents(api, session?.id ?? '');
  const activity = events.filter((e) => e.runId === running?.id).slice(-1)[0];
  useEffect(() => {
    if (pendingRun && data.runs.some((r) => r.id === pendingRun)) setPendingRun('');
  }, [pendingRun, data.runs]);
  useEffect(() => {
    setMessages([]);
    setError('');
    setPendingRun('');
    setHasEarlier(false);
    follow.current = true;
    try {
      const text =
        carryDraft.current ?? localStorage.getItem('tongzhou.canvas.chat.' + identity) ?? '';
      setPrompt(text);
      if (carryDraft.current !== undefined)
        localStorage.setItem('tongzhou.canvas.chat.' + identity, text);
    } catch {
      setPrompt(carryDraft.current ?? '');
    }
    if (session) carryDraft.current = undefined;
    if (!session) return;
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const merge = (incoming: Message[]) => {
      if (!live) return;
      setMessages((old) => {
        const byId = new Map(old.map((m) => [m.id, m]));
        for (const m of incoming) byId.set(m.id, m);
        return [...byId.values()].sort(
          (a, b) => a.createdAt - b.createdAt || (a.sequence ?? 0) - (b.sequence ?? 0),
        );
      });
    };
    const refresh = async (initial = false) => {
      try {
        const all = await api.messages(session.id, { limit: 100 });
        if (!live) return;
        if (initial) setHasEarlier(all.length === 100);
        merge(all);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    };
    const off = api.onEvent((e) => {
      if (e.type === 'message' && e.message.sessionId === session.id) merge([e.message]);
      if (e.type === 'messages-removed' && e.sessionId === session.id)
        setMessages((old) => old.filter((m) => !e.ids.includes(m.id)));
      if (e.type === 'changed' && !timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh();
        }, 250);
    });
    void refresh(true);
    return () => {
      live = false;
      off();
      clearTimeout(timer);
    };
  }, [api, identity]);
  const turns = canvasChatTurns(messages, canvas.id);
  const runs = new Set(turns.map((t) => t.user.runId));
  const lastRun = data.runs
    .filter((r) => r.sessionId === session?.id && runs.has(r.id))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  useEffect(() => {
    if (open && follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [messages, working, open]);
  useEffect(() => {
    const el = feed.current;
    if (!el || !open) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);
  const perform = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (latestIdentity.current === identity) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const editPrompt = (text: string) => {
    setPrompt(text);
    try {
      localStorage.setItem('tongzhou.canvas.chat.' + identity, text);
    } catch {}
  };
  const createSession = async () => {
    carryDraft.current = prompt;
    try {
      await onCreate();
    } catch (error) {
      carryDraft.current = undefined;
      throw error;
    }
  };
  const send = async (resume?: string) => {
    const text = (resume ?? prompt).trim();
    if (!session || !text || working || busy || blocked || sending.current) return;
    sending.current = true;
    await perform(async () => {
      await onPrepare();
      if (latestIdentity.current !== identity) return;
      // Initialize only inherited permissions; preserve explicit choices on later turns.
      if (session.permission === undefined)
        await api.setSessionPermission(session.id, 'full-access');
      if (latestIdentity.current !== identity) return;
      const id = await api.run({
        sessionId: session.id,
        providerId: session.providerId,
        model: session.model,
        agentId: session.agentId,
        prompt: canvasChatPrompt(canvas.id, text),
      });
      if (latestIdentity.current !== identity) return;
      setPendingRun(id);
      if (!resume) editPrompt('');
      follow.current = true;
    });
    sending.current = false;
  };
  const approvals = data.approvals.filter((a) => a.sessionId === session?.id);
  const models = data.providers
    .filter((p) => p.enabled !== false)
    .flatMap((p) =>
      p.models.map((model) => ({
        key: JSON.stringify([p.id, model]),
        label: `${p.name} · ${p.modelLabels?.[model] ?? model}`,
      })),
    );
  const currentModel = session ? JSON.stringify([session.providerId, session.model]) : '';
  const lastUser = turns.at(-1)?.user;
  const lastWorkflow = workflowRuns
    .filter((r) => r.sessionId === session?.id && r.startedAt >= (lastRun?.startedAt ?? Infinity))
    .at(0);
  const activeTools = messages.filter((m) => m.runId === running?.id && m.role === 'tool');
  const activeTool = activeTools.at(-1);
  const status = approvals.length
    ? '等待你确认'
    : activeTool?.status === 'streaming'
      ? (canvasToolLabels[activeTool.toolName ?? ''] ?? '正在执行操作')
      : /参数格式不完整/.test(activity?.text ?? '')
        ? '正在重新整理修改参数…'
        : '正在分析并配置画布…';
  return (
    <section className="canvas-assistant" aria-label="画布助手">
      <header className="canvas-chat-heading">
        <strong>画布助手</strong>
        <div className="canvas-inline-actions">
          <button
            aria-label="会话设置"
            title="模型与会话设置"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <Settings2 size={16} />
          </button>
          <button aria-label="收起画布聊天" title="收起" onClick={onCollapse}>
            <Minus size={16} />
          </button>
        </div>
      </header>
      {settingsOpen && (
        <div className="canvas-chat-settings">
          <small>画布聊天默认完全开放；沿用会话中已明确设置的权限。权限修改也适用于该会话。</small>
          <div className="canvas-chat-session">
            <select
              aria-label="画布聊天会话"
              value={session?.id ?? ''}
              disabled={busy || working}
              onChange={(e) => void perform(() => onBind(e.target.value))}
            >
              <option value="">选择会话</option>
              {data.sessions
                .filter((s) => isUserSession(s) && !s.archived)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
            </select>
            <button disabled={busy || working} onClick={() => void perform(createSession)}>
              新建会话
            </button>
          </div>
          {session && (
            <>
              <label>
                执行权限
                <select
                  aria-label="画布聊天权限"
                  value={permission}
                  disabled={busy || agent?.permission === 'read-only'}
                  onChange={(e) =>
                    void perform(() =>
                      api.setSessionPermission(session.id, e.target.value as PermissionMode),
                    )
                  }
                >
                  {Object.entries(permissionLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => onSession(session)}>完整会话</button>
            </>
          )}
        </div>
      )}
      {session && (
        <select
          aria-label="画布聊天模型"
          value={currentModel}
          disabled={busy || working}
          onChange={(e) =>
            void perform(async () => {
              const [providerId, model] = JSON.parse(e.target.value) as [string, string];
              await api.updateSession(session.id, { providerId, model });
            })
          }
        >
          {!models.some((m) => m.key === currentModel) && (
            <option value={currentModel}>{session.model || '请选择模型'}</option>
          )}
          {models.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      )}
      <small>
        {canvas.selection.length ? `当前选中 ${canvas.selection.length} 个节点` : '围绕整个画布'} ·{' '}
        {readOnly ? '当前会话只读，仅讨论' : '按需求直接配置，修改实时同步'}
      </small>
      <div
        className="canvas-chat-messages"
        ref={feed}
        role="log"
        aria-label="画布聊天记录"
        onWheel={(e) => {
          if (e.deltaY < 0) follow.current = false;
        }}
        onPointerDown={() => {
          draggingFeed.current = true;
        }}
        onPointerUp={() => {
          draggingFeed.current = false;
        }}
        onPointerCancel={() => {
          draggingFeed.current = false;
        }}
        onKeyDown={(e) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) follow.current = false;
        }}
        onScroll={() => {
          if (!open) return;
          const el = feed.current!;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          if (bottom || draggingFeed.current) follow.current = bottom;
        }}
      >
        {hasEarlier && (
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const old = await api.messages(session!.id, {
                  before: messages[0]?.id,
                  limit: 100,
                });
                if (latestIdentity.current !== identity) return;
                follow.current = false;
                setHasEarlier(old.length === 100);
                setMessages((items) => [
                  ...old.filter((m) => !items.some((v) => v.id === m.id)),
                  ...items,
                ]);
              })
            }
          >
            加载更早对话
          </button>
        )}
        {!turns.length && (
          <div className="canvas-chat-empty">
            <strong>你描述需求，我来配置画布</strong>
            <p>创建节点、连接流程、调整参数，修改会直接显示在画布上。</p>
            {['创建一个小猫图片生成节点', '搭建小说人物和场景提取流程'].map((text) => (
              <button
                key={text}
                onClick={() => {
                  editPrompt(text);
                  composer.current?.focus();
                }}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        {turns.map(({ user, replies, tools }) => {
          const run = data.runs.find((r) => r.id === user.runId);
          const applied = tools.filter(
            (m) => m.toolName === 'canvas_apply' && m.status === 'complete',
          ).length;
          const final = replies.at(-1);
          const failed = run?.status === 'failed' || replies.some((m) => m.status === 'error');
          const textReplies = replies.filter((m) => m.phase !== 'commentary');
          const shown = textReplies.length ? textReplies : replies.slice(-1);
          return (
            <div className="canvas-chat-turn" key={user.id}>
              <article className="canvas-chat-message user">
                <Markdown text={canvasChatUserText(user.content)} />
              </article>
              {(replies.length > 0 || tools.length > 0) && (
                <article className="canvas-chat-message assistant">
                  {!!tools.length && (
                    <details className="canvas-chat-steps">
                      <summary>
                        {applied
                          ? `已更新画布 · ${applied} 次修改`
                          : run?.status === 'running'
                            ? '正在处理'
                            : failed
                              ? '处理未完成'
                              : '处理记录'}{' '}
                        · {tools.length} 步
                      </summary>
                      {tools.map((tool) => (
                        <div key={tool.id}>
                          {tool.status === 'complete' ? (
                            <Check size={12} />
                          ) : tool.status === 'error' ? (
                            <AlertCircle size={12} />
                          ) : (
                            <LoaderCircle size={12} className="spin" />
                          )}
                          {canvasToolLabels[tool.toolName ?? ''] ?? tool.toolName ?? '工具操作'}
                          <small>
                            {tool.status === 'complete'
                              ? '完成'
                              : tool.status === 'error'
                                ? '失败'
                                : '进行中'}
                          </small>
                        </div>
                      ))}
                    </details>
                  )}
                  {shown.map((m) => (
                    <div key={m.id}>
                      <Markdown text={m.content} streaming={m.status === 'streaming'} />
                      {m.artifactIds?.slice(0, 8).map((id) => (
                        <ResourceThumbnail key={id} api={api} resource={{ kind: 'artifact', id }} />
                      ))}
                    </div>
                  ))}
                  {final && !failed && run?.status === 'completed' && (
                    <details className="canvas-chat-actions">
                      <summary>更多操作</summary>
                      <div className="canvas-inline-actions">
                        <button onClick={() => onInsert(final, false)}>插入画布</button>
                        <button
                          disabled={canvas.selection.length !== 1}
                          onClick={() => onInsert(final, true)}
                        >
                          替换选中节点
                        </button>
                      </div>
                    </details>
                  )}
                </article>
              )}
            </div>
          );
        })}
        {lastWorkflow && (
          <div className="canvas-chat-workflow" role="status">
            {lastWorkflow.status === 'running'
              ? '工作流正在执行，结果会显示在节点上'
              : lastWorkflow.status === 'completed'
                ? '工作流执行完成，可在节点中查看结果'
                : '工作流未完成'}
            {lastWorkflow.error && <small>{lastWorkflow.error}</small>}
          </div>
        )}
      </div>
      {working && (
        <p className="canvas-chat-status" role="status">
          <LoaderCircle size={14} className="spin" />
          {status}
        </p>
      )}

      <ApprovalQueue
        approvals={approvals}
        onDecide={(id, allow) => api.approve(id, allow)}
        onAnswer={(id, answers) => api.answerQuestions(id, answers)}
      />
      {error && <p role="alert">{error}</p>}
      {!working && lastRun?.error && (
        <div className="canvas-chat-error" role="alert">
          <strong>这次没有完成</strong>
          <p>{canvasChatError(lastRun.error)}</p>
          <details>
            <summary>错误详情</summary>
            <p>{lastRun.error}</p>
          </details>
          {lastUser && (
            <div className="canvas-inline-actions">
              <button
                disabled={busy || blocked}
                onClick={() =>
                  void send(
                    '继续完成：' +
                      canvasChatUserText(lastUser.content).replace(/^(继续完成：)+/, ''),
                  )
                }
              >
                继续完成
              </button>
              <button
                onClick={() => {
                  editPrompt(canvasChatUserText(lastUser.content));
                  composer.current?.focus();
                }}
              >
                修改需求
              </button>
            </div>
          )}
        </div>
      )}
      {!working && lastRun?.status === 'interrupted' && (
        <small>回复已停止，可以继续描述需求。</small>
      )}
      {blocked && <p role="alert">画布有并发修改，请先处理上方冲突，再继续发送。</p>}
      <textarea
        ref={composer}
        aria-label="向画布助手提问"
        value={prompt}
        onChange={(e) => editPrompt(e.target.value)}
        placeholder="例如：搭建小说人物提取流程，再连接到图片生成节点"
        maxLength={12000}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="canvas-chat-send">
        <small>Enter 发送 · Shift+Enter 换行</small>
        {working ? (
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await api.cancel(session!.id);
                setPendingRun('');
              })
            }
          >
            <Square size={14} /> 停止回复
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || blocked || !session?.providerId || !session.model || !prompt.trim()}
            onClick={() => void send()}
          >
            <ArrowUp size={15} /> {busy ? '发送中…' : '发送'}
          </button>
        )}
      </div>
      {!session && (
        <button disabled={busy} onClick={() => void perform(createSession)}>
          新建画布会话，开始配置
        </button>
      )}
    </section>
  );
}
