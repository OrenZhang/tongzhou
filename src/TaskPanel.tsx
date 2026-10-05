import { useEffect, useState, lazy, Suspense } from 'react';
import { Modal } from './components';
import type { TongzhouAPI } from './shared/types';
import type { HistoryMatch, TaskState } from './shared/task';
import './task-panel.css';

const TerminalView = lazy(() => import('./TerminalView'));

export function TaskPanel({
  api,
  sessionId,
  projectId,
  onClose,
  onSelectSession,
}: {
  api: TongzhouAPI;
  sessionId: string;
  projectId?: string;
  onClose: () => void;
  onSelectSession: (id: string) => void;
}) {
  const [tab, setTab] = useState('task'),
    [state, setState] = useState<TaskState>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [terminal, setTerminal] = useState(''),
    [patch, setPatch] = useState(''),
    [commit, setCommit] = useState(''),
    [confirmRestore, setConfirmRestore] = useState('');
  const [staged, setStaged] = useState<string[]>([]);
  const [stagedHash, setStagedHash] = useState('');
  const report = (e: unknown) => setError(String(e).replace(/^Error: /, ''));
  const refresh = async () => {
    setState(await api.taskState(sessionId));
  };
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.taskState(sessionId).then(
        (s) => {
          if (alive) setState(s);
        },
        (e) => {
          if (alive) report(e);
        },
      );
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, sessionId]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await fn();
      if (typeof r === 'string') setNotice(r);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const last = state?.runs[0];
  return (
    <Modal
      title="任务与交付"
      subtitle="任务记忆、持久终端、改动和验证记录集中在这里。"
      wide
      onClose={onClose}
    >
      <div className="task-panel">
        <div className="task-tabs" role="tablist">
          {[
            ['task', '任务'],
            ['terminal', '终端'],
            ['changes', '本轮改动'],
            ['evidence', '验证记录'],
            ['history', '搜索历史'],
          ].map(([id, label]) => (
            <button role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {error && (
          <div className="task-error" role="alert">
            {error}
            <button className="text-button" disabled={busy} onClick={() => void act(refresh)}>
              重试读取
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="info-strip">
            {notice}
          </p>
        )}
        {!state && !error && <p role="status">正在读取任务…</p>}
        {tab === 'task' && state && (
          <>
            {last && (
              <section className="task-block">
                <h3>
                  最近一次运行 ·{' '}
                  {
                    {
                      running: '进行中',
                      completed: '已结束',
                      failed: '失败',
                      interrupted: '已中断',
                    }[last.status]
                  }
                </h3>
                <p>{last.error || last.phase || '已保存运行记录'}</p>
                {['failed', 'interrupted'].includes(last.status) && (
                  <>
                    <p className="muted">
                      继续时先核对文件、工具结果和终端状态；不会自动重放上次操作。
                    </p>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.resumeTask(sessionId);
                          onClose();
                        })
                      }
                    >
                      检查并继续任务
                    </button>
                  </>
                )}
              </section>
            )}
            <section className="task-block">
              <h3>任务记忆</h3>
              {state.memory ? (
                <>
                  <p>{state.memory.goal}</p>
                  {(
                    [
                      ['constraints', '用户约束'],
                      ['decisions', '已定方案'],
                      ['completed', '已完成记录'],
                      ['nextSteps', '下一步'],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key}>
                      <h4>{label}</h4>
                      {state.memory![key].length ? (
                        <ul>
                          {state.memory![key].map((text, i) => (
                            <li key={i}>{text}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">暂无记录</p>
                      )}
                    </div>
                  ))}
                  <p className="muted">记忆由 Agent 维护，完成情况请结合验证记录检查。</p>
                </>
              ) : (
                <p className="muted">
                  尚未保存任务记忆。长任务中 Agent
                  可以自动记录目标、约束和下一步；原始要求可在“搜索历史”找回。
                </p>
              )}
            </section>
          </>
        )}
        {tab === 'terminal' && (
          <>
            <div className="task-toolbar">
              <select
                aria-label="选择终端"
                value={terminal}
                onChange={(e) => setTerminal(e.target.value)}
              >
                <option value="">选择终端</option>
                {state?.terminals.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} · {t.status === 'running' ? '运行中' : '已结束'}
                  </option>
                ))}
              </select>
              <button
                className="primary"
                disabled={busy || !projectId}
                onClick={() =>
                  void act(async () => {
                    const t = await api.startTerminal(sessionId);
                    setTerminal(t.id);
                  })
                }
              >
                新建终端
              </button>
              {terminal && (
                <button
                  className="secondary"
                  disabled={
                    busy || state?.terminals.find((t) => t.id === terminal)?.status !== 'running'
                  }
                  onClick={() => void act(() => api.stopTerminal(sessionId, terminal))}
                >
                  停止终端
                </button>
              )}
            </div>
            {!projectId && <p className="muted">打开项目后可以使用终端。</p>}
            {terminal ? (
              <Suspense fallback={<p>正在打开终端…</p>}>
                <TerminalView
                  key={terminal}
                  api={api}
                  sessionId={sessionId}
                  id={terminal}
                  onError={report}
                />
              </Suspense>
            ) : (
              <p className="task-empty">
                终端可跨会话轮次持续运行，关闭此面板不会停止服务。退出客户端会停止终端。
              </p>
            )}
          </>
        )}
        {tab === 'changes' && (
          <>
            {!state?.changes.length && (
              <p className="task-empty">项目任务结束后，在这里查看本轮前后的文本改动。</p>
            )}
            {state?.changes
              .slice()
              .reverse()
              .map((c) => (
                <section className="task-block" key={c.id}>
                  <h3>
                    {new Date(c.createdAt).toLocaleString()} · {c.files.length} 个文件
                  </h3>
                  <p className="muted">
                    文本检查点；不包含依赖、构建产物、密钥文件及超大文件。跳过 {c.skipped}{' '}
                    项。工作区并发修改也可能包含在差异中。
                  </p>
                  {c.files.map((f) => (
                    <div className="task-file" key={f.path}>
                      <button
                        className="text-button"
                        onClick={() =>
                          void act(async () => setPatch(await api.runPatch(c.id, f.path)))
                        }
                      >
                        {f.path}
                      </button>
                      <span>{f.restored ? '已恢复' : ''}</span>
                      <button
                        className="secondary"
                        disabled={busy || f.restored}
                        onClick={() => void act(() => api.stageRunFile(c.id, f.path))}
                      >
                        暂存
                      </button>
                      {confirmRestore === c.id + f.path ? (
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const r = await api.restoreRunFile(c.id, f.path);
                              setConfirmRestore('');
                              return r;
                            })
                          }
                        >
                          确认恢复本轮前内容
                        </button>
                      ) : (
                        <button
                          className="text-button"
                          disabled={busy || f.restored}
                          onClick={() => setConfirmRestore(c.id + f.path)}
                        >
                          恢复…
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              ))}
            {patch && (
              <pre className="task-patch">
                {patch.split('\n').map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''
                    }
                  >
                    {line || ' '}
                  </div>
                ))}
              </pre>
            )}
            {projectId && (
              <section className="task-block">
                <h3>提交已暂存内容</h3>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await api.projectChanges(projectId, 'staged');
                      const reviewed = await api.reviewStaged(projectId);
                      setStaged(result.changes.map((f) => f.path));
                      setStagedHash(reviewed.hash);
                      setPatch(reviewed.patch);
                    })
                  }
                >
                  检查已暂存文件
                </button>
                {staged.length > 0 && (
                  <ul>
                    {staged.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
                <div className="task-toolbar">
                  <input
                    aria-label="提交说明"
                    placeholder="描述此次修改"
                    value={commit}
                    onChange={(e) => setCommit(e.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={busy || !commit.trim() || !staged.length}
                    onClick={() =>
                      void act(async () => {
                        const r = await api.commitStaged(projectId, commit, stagedHash);
                        setCommit('');
                        setStaged([]);
                        return r;
                      })
                    }
                  >
                    提交全部已暂存内容
                  </button>
                </div>
              </section>
            )}
          </>
        )}
        {tab === 'evidence' && (
          <>
            <p className="muted">
              以下为实际工具记录。运行结束和工具执行成功，不自动等于项目测试通过。
            </p>
            {state?.evidence.length ? (
              state.evidence.map((e) => (
                <details key={e.id} className="task-block">
                  <summary>
                    {e.toolName || '工具'} · {e.status === 'error' ? '失败' : '已返回结果'}
                  </summary>
                  <pre>{e.content}</pre>
                </details>
              ))
            ) : (
              <p className="task-empty">暂无工具验证记录</p>
            )}
          </>
        )}
        {tab === 'history' && (
          <HistorySearch api={api} sessionId={sessionId} onSelectSession={onSelectSession} />
        )}
      </div>
    </Modal>
  );
}

export function HistorySearch({
  api,
  sessionId,
  onSelectSession,
}: {
  api: TongzhouAPI;
  sessionId?: string;
  onSelectSession: (id: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [all, setAll] = useState(!sessionId),
    [matches, setMatches] = useState<HistoryMatch[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [selected, setSelected] = useState<HistoryMatch>(),
    [content, setContent] = useState(''),
    [next, setNext] = useState<number | null>(null);
  const search = async (more = false) => {
    setBusy(true);
    setError('');
    try {
      const rows = await api.searchMessages(
        query,
        all ? undefined : sessionId,
        more ? matches.at(-1)?.seq : undefined,
      );
      setMatches((old) => (more ? [...old, ...rows] : rows));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const read = async (hit: HistoryMatch, offset = 0) => {
    setBusy(true);
    setError('');
    try {
      const r = await api.historyMessage(hit.sessionId, hit.id, offset);
      setSelected(hit);
      setContent((old) => (offset ? old + r.content : r.content));
      setNext(r.nextOffset);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="history-search">
      <form
        className="task-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="搜索消息内容"
          placeholder="搜索消息内容，留空浏览最近消息"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          全部会话
        </label>
        <button className="primary" disabled={busy}>
          搜索
        </button>
      </form>
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
      {busy && <p role="status">正在读取…</p>}
      {matches.map((m) => (
        <button key={m.id} className="history-hit" disabled={busy} onClick={() => void read(m)}>
          <small>
            {new Date(m.createdAt).toLocaleString()} ·{' '}
            {m.role === 'user' ? '你' : m.role === 'tool' ? '工具' : '助手'}
          </small>
          <span>{m.excerpt}</span>
        </button>
      ))}
      {matches.length >= 30 && (
        <button className="secondary" disabled={busy} onClick={() => void search(true)}>
          加载更早结果
        </button>
      )}
      {selected && (
        <section className="task-block">
          <div className="task-toolbar">
            <button className="secondary" onClick={() => onSelectSession(selected.sessionId)}>
              打开所属会话
            </button>
            <button className="secondary" onClick={() => void api.copyText(content)}>
              复制已加载原文
            </button>
          </div>
          <pre>{content}</pre>
          {next !== null && (
            <button className="secondary" disabled={busy} onClick={() => void read(selected, next)}>
              继续读取原文
            </button>
          )}
        </section>
      )}
    </section>
  );
}
