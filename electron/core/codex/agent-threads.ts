import type { ChildAgent } from '../../../src/shared/agent-execution';
import type { ToolScope } from '../tools/extensions';
import type { CodexClient } from './codex';

/** One native thread tree; each child owns its cancellation and business-tool resources. */
export class AgentThreads {
  root = '';
  rootTurnId = '';
  private rootActive = false;
  private nodes = new Map<string, ChildAgent>();
  private contexts = new Map<string, { controller: AbortController; scope?: Promise<ToolScope> }>();
  private subscriptions = new Map<string, Promise<void>>();
  private cleanup = new Set<Promise<void>>();
  private closed = false;
  private usageBase = new Map<string, { inputTokens: number; outputTokens: number }>();
  private abortChildren = () => {
    for (const context of this.contexts.values()) context.controller.abort();
  };
  constructor(
    private client: CodexClient,
    private signal: AbortSignal,
    private rootScope: ToolScope,
    private prepareScope:
      | ((signal: AbortSignal, threadId: string) => Promise<ToolScope>)
      | undefined,
    private changed: (agents: ChildAgent[]) => void,
    private options: {
      model?: string;
      effort?: string;
      previous?: ChildAgent[];
      onItem?: (params: { threadId: string; turnId: string; item: any }) => void;
    } = {},
  ) {
    for (const agent of options.previous ?? [])
      if (agent.usageTotal) this.usageBase.set(agent.threadId, agent.usageTotal);
    signal.addEventListener('abort', this.abortChildren, { once: true });
  }
  private release(context: { scope?: Promise<ToolScope> }) {
    const pending = (async () => {
      if (context.scope) {
        const tools = await context.scope;
        await tools.close();
        await tools.settle();
      }
    })();
    this.cleanup.add(pending);
    void pending.finally(() => this.cleanup.delete(pending)).catch(() => {});
    return pending;
  }
  private subscribe(id: string) {
    if (this.subscriptions.has(id)) return;
    const pending = (async () => {
      for (let attempt = 0; attempt < 4 && !this.closed; attempt++) {
        try {
          const { thread } = await this.client.request('thread/resume', { threadId: id });
          if (!thread || !this.owns(thread.parentThreadId)) throw new Error('子线程父级校验失败');
          this.update(id, thread.parentThreadId, {
            directInput: thread.canAcceptDirectInput,
            name: thread.agentNickname ?? this.nodes.get(id)?.name ?? '子 Agent',
            ...(thread.model ? { model: thread.model } : {}),
            ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
          });
          const turn = thread.turns?.at(-1);
          if (turn && (!this.nodes.get(id)?.turnId || this.nodes.get(id)?.turnId === turn.id)) {
            this.observe('turn/started', { threadId: id, turn });
            for (const item of turn.items ?? []) {
              const params = { threadId: id, turnId: turn.id, item };
              if (this.options.onItem) this.options.onItem(params);
              else this.observe('item/completed', params);
            }
            if (turn.status !== 'inProgress')
              this.observe('turn/completed', { threadId: id, turn });
          }
          return;
        } catch (error) {
          if (attempt === 3 || !/empty|not found|no rollout|does not exist/i.test(String(error)))
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * 3 ** attempt));
        }
      }
    })();
    this.subscriptions.set(id, pending);
    void pending.catch((error) => {
      if (!this.closed)
        this.update(id, this.nodes.get(id)!.parentThreadId, {
          status: 'failed',
          message: String(error).slice(0, 4000),
        });
    });
  }
  get hasAgents() {
    return this.nodes.size > 0;
  }
  usage() {
    const nodes = [...this.nodes.values()];
    return {
      inputTokens: nodes.reduce((sum, node) => sum + (node.inputTokens ?? 0), 0),
      outputTokens: nodes.reduce((sum, node) => sum + (node.outputTokens ?? 0), 0),
      incomplete: nodes.some((node) => !node.usageReported),
    };
  }
  owns(id: string) {
    return !this.closed && !this.signal.aborted && (id === this.root || this.nodes.has(id));
  }
  accepts(id: string, turnId?: string) {
    if (!this.owns(id)) return false;
    const node = this.nodes.get(id);
    return (
      !node ||
      ((!node.turnId || !turnId || node.turnId === turnId) &&
        !['completed', 'interrupted', 'failed', 'closed'].includes(node.status))
    );
  }
  signalFor(id: string) {
    if (id === this.root) return this.signal;
    const context = this.contexts.get(id);
    if (!context || context.controller.signal.aborted) throw new Error('子任务已停止');
    return context.controller.signal;
  }
  async tools(id: string, name: string) {
    this.rootScope.assertAvailable(name);
    if (id === this.root) return this.rootScope;
    if (!this.prepareScope) throw new Error('当前宿主未提供子任务工具作用域');
    const context = this.contexts.get(id);
    this.signalFor(id);
    context!.scope ??= this.prepareScope(context!.controller.signal, id);
    return context!.scope;
  }
  private update(id: string, parent: string, fields: Partial<ChildAgent>) {
    if (!id || id === this.root || !this.owns(parent)) return;
    const old = this.nodes.get(id);
    const node: ChildAgent = {
      threadId: id,
      parentThreadId: parent,
      name: '子 Agent',
      status: 'pending',
      ...old,
      ...fields,
    };
    node.model ??= this.options.model;
    node.reasoningEffort ??= this.options.effort;
    if (!this.contexts.has(id)) this.contexts.set(id, { controller: new AbortController() });
    this.nodes.set(id, node);
    if (JSON.stringify(old) !== JSON.stringify(node))
      this.changed([...this.nodes.values()].slice(-32));
    if (!old) this.subscribe(id);
  }
  observe(method: string, p: any) {
    if (this.closed) return;
    if (method === 'thread/started' && p.thread?.parentThreadId)
      this.update(p.thread.id, p.thread.parentThreadId, {
        name: p.thread.agentNickname ?? p.thread.name ?? '子 Agent',
        model: p.thread.model ?? undefined,
        reasoningEffort: p.thread.reasoningEffort ?? undefined,
      });
    if (!this.owns(p.threadId)) return;
    if (p.threadId === this.root && method === 'turn/started') {
      this.rootTurnId = p.turn.id;
      this.rootActive = true;
    }
    if (p.threadId === this.root && method === 'turn/completed') this.rootActive = false;
    const item = p.item;
    if (item?.type === 'collabAgentToolCall') {
      const statuses: Record<string, ChildAgent['status']> = {
        pendingInit: 'pending',
        running: 'running',
        interrupted: 'interrupted',
        completed: 'completed',
        errored: 'failed',
        shutdown: 'closed',
        notFound: 'closed',
      };
      for (const id of item.receiverThreadIds ?? []) {
        const state = item.agentsStates?.[id];
        this.update(id, p.threadId, {
          ...(item.model ? { model: item.model } : {}),
          ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
          ...(state
            ? {
                status: statuses[state.status] ?? 'pending',
                message: state.message?.slice(0, 4000) ?? undefined,
              }
            : {}),
        });
      }
    }
    if (item?.type === 'subAgentActivity')
      this.update(item.agentThreadId, p.threadId, {
        path: item.agentPath,
        name: item.agentPath?.split('/').at(-1) ?? '子 Agent',
        ...(item.model ? { model: item.model } : {}),
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
        ...(item.kind === 'interrupted' ? { status: 'interrupted' } : {}),
      });
    const node = this.nodes.get(p.threadId);
    if (!node) return;
    if (method === 'turn/started') {
      const context = this.contexts.get(node.threadId)!;
      if (context.controller.signal.aborted)
        this.contexts.set(node.threadId, { controller: new AbortController() });
      this.update(node.threadId, node.parentThreadId, {
        turnId: p.turn.id,
        status: 'running',
        pendingAction: undefined,
        startedAt: node.startedAt ?? Date.now(),
        endedAt: undefined,
      });
    }
    const eventTurn = p.turnId ?? p.turn?.id;
    if (eventTurn && node.turnId && method !== 'turn/started' && eventTurn !== node.turnId) return;
    if (method === 'thread/status/changed' && p.status?.type === 'active')
      this.update(node.threadId, node.parentThreadId, {
        status: p.status.activeFlags?.length ? 'waiting' : 'running',
        phase: p.status.activeFlags?.includes('waitingOnApproval')
          ? '等待审批'
          : p.status.activeFlags?.includes('waitingOnUserInput')
            ? '等待回答'
            : undefined,
      });
    if (method === 'model/rerouted' && typeof p.toModel === 'string')
      this.update(node.threadId, node.parentThreadId, { model: p.toModel });
    if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) {
      const usage = p.tokenUsage.total;
      const base = this.usageBase.get(node.threadId);
      this.update(node.threadId, node.parentThreadId, {
        usageTotal: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        inputTokens: Math.max(0, usage.inputTokens - (base?.inputTokens ?? 0)),
        outputTokens: Math.max(0, usage.outputTokens - (base?.outputTokens ?? 0)),
        usageReported: true,
      });
    }
    if (method === 'item/completed' && item?.type === 'agentMessage')
      this.update(node.threadId, node.parentThreadId, { message: item.text?.slice(0, 4000) });
    if (method === 'turn/completed') {
      this.update(node.threadId, node.parentThreadId, {
        endedAt: Date.now(),
        phase: undefined,
        status:
          p.turn.status === 'completed'
            ? 'completed'
            : p.turn.status === 'interrupted'
              ? 'interrupted'
              : 'failed',
        ...(p.turn.error?.message ? { message: p.turn.error.message.slice(0, 4000) } : {}),
      });
      this.contexts.get(node.threadId)?.controller.abort();
      void this.release(this.contexts.get(node.threadId)!).catch(() => {});
    }
  }
  async control(id: string, action: 'interrupt' | 'resume') {
    const node = this.nodes.get(id);
    if (this.closed || this.signal.aborted || !node) throw new Error('子任务不属于当前运行任务');
    if (action === 'interrupt') {
      if (!node.turnId || !['running', 'waiting', 'pending'].includes(node.status))
        throw new Error('子任务当前未运行');
      this.contexts.get(id)?.controller.abort();
      await this.client.request('turn/interrupt', { threadId: id, turnId: node.turnId });
      this.update(id, node.parentThreadId, { status: 'interrupted' });
    } else {
      if (!['interrupted', 'failed'].includes(node.status))
        throw new Error('仅能继续已中断的子任务');
      if (node.pendingAction) throw new Error('继续请求已送达，等待主 Agent 处理');
      if (node.directInput === false) {
        if (!this.rootActive) throw new Error('主任务已结束，请在输入框继续');
        await this.client.request('turn/steer', {
          threadId: this.root,
          expectedTurnId: this.rootTurnId,
          input: [
            {
              type: 'text',
              text: `用户请求继续子任务 ${node.path ?? node.threadId}。通过原生 followup_task 恢复同一子任务，先核对已有回执和部分执行结果，避免重复操作。`,
            },
          ],
        });
        if (['interrupted', 'failed'].includes(this.nodes.get(id)!.status))
          this.update(id, node.parentThreadId, { pendingAction: 'resume' });
        return;
      }
      const previous = this.contexts.get(id);
      if (previous) await this.release(previous);
      this.contexts.set(id, { controller: new AbortController() });
      const result = await this.client.request('turn/start', {
        threadId: id,
        input: [
          {
            type: 'text',
            text: '继续当前子任务。先核对实际状态和已有回执，不要重放已成功或部分完成的操作。',
          },
        ],
      });
      if (!result.turn?.id) throw new Error('核心未确认子任务恢复');
    }
  }
  async close() {
    this.closed = true;
    this.signal.removeEventListener('abort', this.abortChildren);
    for (const [id, context] of this.contexts) {
      context.controller.abort();
      const node = this.nodes.get(id)!;
      node.pendingAction = undefined;
      if (['pending', 'running', 'waiting'].includes(node.status)) {
        if (node.turnId)
          void this.client
            .request('turn/interrupt', { threadId: id, turnId: node.turnId })
            .catch(() => {});
        node.status = 'interrupted';
        node.endedAt = Date.now();
        node.phase = undefined;
      }
    }
    try {
      if (this.hasAgents) this.changed([...this.nodes.values()].slice(-32));
    } finally {
      await Promise.allSettled([...this.subscriptions.values()]);
      await Promise.allSettled([...this.contexts.values()].map((context) => this.release(context)));
      await Promise.allSettled([...this.cleanup]);
    }
  }
  async input(id: string, text: string) {
    if (!this.owns(id) || !this.rootActive) return false;
    const node = this.nodes.get(id);
    if (node?.directInput === false) {
      await this.client.request('turn/steer', {
        threadId: this.root,
        expectedTurnId: this.rootTurnId,
        input: [
          {
            type: 'text',
            text: `用户给子任务 ${node.path ?? node.threadId} 的补充回答如下，请使用原生 send_message 或 followup_task 交给同一子任务：\n${text}`,
          },
        ],
      });
      return true;
    }
    const turnId = node?.turnId ?? this.rootTurnId;
    if (!node || ['running', 'waiting'].includes(node.status))
      await this.client.request('turn/steer', {
        threadId: id,
        expectedTurnId: turnId,
        input: [{ type: 'text', text }],
      });
    else {
      const context = this.contexts.get(id);
      if (context) await this.release(context);
      this.contexts.set(id, { controller: new AbortController() });
      await this.client.request('turn/start', { threadId: id, input: [{ type: 'text', text }] });
    }
    return true;
  }
}
