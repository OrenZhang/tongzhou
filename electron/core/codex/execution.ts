import { botSettings } from '../../services/bots/settings';
import type { ExecutionAdapter, ExecutionCallbacks } from '../task-contracts';
import { SessionLifecycle } from '../../modules/sessions/session-lifecycle';
import { executionContext, executionTranscript } from '../runtime/execution-evidence';
import { codexThinking, thinkingRequest } from '../runtime/thinking';
import { IdleTimeout } from '../runtime/idle-timeout';
import { Attachments } from '../../modules/artifacts/attachments';
import { sessionWorkspace } from '../../modules/sessions/session-workspace';
import type {
  AgentProfile,
  Message,
  Project,
  Provider,
  Run,
  RunInput,
  Session,
} from '../../../src/shared/types';
import { engineHome } from '../../services/accounts/account-paths';
import { Store } from '../../services/storage/store';
import { ToolScope } from '../tools/extensions';
import { nativeEngine } from '../../services/accounts/native-engine';
import { CodexClient } from './codex';
import { modelGateway } from '../models/model-gateway';
import { nativeModelConnection } from '../models/native-model';
import { CodexSessions } from './codex-sessions';
import { resumableSegment, type EngineSegment } from './thread-state';
import {
  BUSINESS_TOOL_NAMESPACE,
  deferredBusinessTools,
  dynamicToolSpecs,
  executionFeatures,
} from './dynamic-tools';
import { AgentThreads } from './agent-threads';
import { nativeToolReceipt } from './native-events';
import { agentPlan } from '../../../src/shared/agent-plan';
import { networkKey } from '../../../src/shared/provider-network';
import { modelProvider, routedProvider } from '../../../src/shared/model-protocol';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ProviderNetwork } from '../../../src/shared/provider-network';

export interface CodexExecutionPorts extends ExecutionCallbacks {
  store: Store;
  dataDir: string;
  resolveNetwork?: (
    network?: ProviderNetwork,
    runId?: string,
  ) => Promise<ProviderNetwork | undefined>;
  modelTransport?: (network: Provider['network']) => Promise<typeof fetch>;
  attachments: Attachments;
  sessions: Pick<SessionLifecycle, 'isDeleting'>;
}

/** Executes a Codex/native-engine turn through explicit persistence, model and event ports. */
export class CodexExecution implements ExecutionAdapter {
  private clients = new Map<string, CodexClient>();
  private trees = new Map<string, { tree: AgentThreads; run: Run }>();
  private codexChats = new CodexSessions();
  private steering = new Map<
    string,
    (text: string, messageId: string, attachmentIds?: string[]) => Promise<void>
  >();
  hasSteering(id: string) {
    return this.steering.has(id);
  }
  steer(id: string, text: string, messageId: string, attachments?: string[]) {
    const handler = this.steering.get(id);
    if (!handler) return Promise.reject(new Error('当前轮次尚未受理'));
    return handler(text, messageId, attachments);
  }
  async removeSession(id: string) {
    await this.codexChats.remove(id);
  }
  controlAgent(sessionId: string, threadId: string, action: 'interrupt' | 'resume') {
    const tree = this.trees.get(sessionId);
    if (!tree) throw new Error('当前会话没有运行中的原生子任务');
    return tree.tree.control(threadId, action);
  }
  async deliverAnswer(sessionId: string, threadId: string, text: string) {
    const live = this.trees.get(sessionId);
    if (live && (await live.tree.input(threadId, text))) return live.run.id;
  }
  async invalidate(id?: string) {
    await this.codexChats.clear(id);
  }
  async close() {
    await Promise.all([
      this.codexChats.clear(),
      ...[...this.clients.values()].map((c) => c.stop()),
    ]);
  }
  constructor(private ports: CodexExecutionPorts) {}
  async run(
    input: RunInput,
    project: Project | null,
    agent: AgentProfile,
    run: Run,
    signal: AbortSignal,
    scope: ToolScope,
    prepareScope?: (signal: AbortSignal, threadId: string) => Promise<ToolScope>,
    checkCompletion?: () => Promise<string | undefined>,
  ) {
    const provider = routedProvider(
      this.ports.store.get<Provider>('provider', input.providerId),
      run.routing,
    );
    const network = this.ports.resolveNetwork
      ? await this.ports.resolveNetwork(provider.network, run.id)
      : provider.network;
    if (signal.aborted) throw new Error('已停止');
    const session = this.ports.store.get<Session>('session', input.sessionId);
    const { nativeFiles, questionsEnabled, interactions } = executionFeatures(
      provider,
      input.model,
      session,
      !!input.botContext,
      botSettings(this.ports.store).mode === 'workbench',
    );
    const cwd = sessionWorkspace(this.ports.store, this.ports.dataDir, input.sessionId);
    if (!project) await mkdir(cwd, { recursive: true });
    const deferred = deferredBusinessTools(provider, input.model, scope.specs.length);
    const fingerprint = JSON.stringify([
      'codex-core-v5-instructions',
      input.providerId,
      provider.protocol,
      provider.modelProtocols,
      provider.baseUrl,
      provider.auth,
      provider.contextChars,
      provider.maxOutputTokens,
      networkKey(provider.network),
      provider.thinkingEnabled !== false,
      provider.reasoningEffort,
      provider.thinkingBudgetTokens,
      ...(run.routing ? ['automatic-model'] : []),
      input.model,
      cwd,
      agent.instructions,
      agent.permission,
      scope.specs,
      deferred,
      interactions,
      questionsEnabled,
    ]);
    const prior = resumableSegment(
      this.ports.store.list<EngineSegment>('engineSegment'),
      this.ports.store.messages(input.sessionId),
      run,
      fingerprint,
    );
    const coreConfig = {
      // Dynamic business tools return structured JSON. Keep their bounded payloads
      // intact; Codex's default small text truncation can split JSON mid-string.
      tool_output_token_limit: 32000,
      'features.multi_agent': interactions,
      'features.multi_agent_v2_dynamic_tools': interactions,
      'agents.max_threads': 4,
      'agents.max_depth': 2,
      'features.skip_host_skill_discovery': true,
      'features.default_mode_request_user_input': questionsEnabled,
      'features.shell_tool': nativeFiles && agent.permission !== 'read-only',
      'features.view_image': nativeFiles,
      'features.goals': !this.ports.store.get<Session>('session', input.sessionId).memoryJob,
      'features.apply_patch_freeform': nativeFiles && agent.permission !== 'read-only',
    };
    const requestThinking = thinkingRequest(modelProvider(provider, input.model), input.model);
    const key = JSON.stringify([fingerprint, networkKey(network)]);
    const warm = await this.codexChats.take(input.sessionId, key, prior?.threadId);
    const customModel = provider.protocol !== 'codex';
    const transport =
      !warm && customModel
        ? await modelGateway({
            sessionId: input.sessionId,
            transport: await this.ports.modelTransport?.(network),
            resolve: async () => {
              const current = this.ports.store.get<Provider>('provider', input.providerId);
              if (current.enabled === false) throw new Error('模型连接已停用');
              return nativeEngine(provider.protocol)
                ? nativeModelConnection(
                    provider,
                    input.model,
                    engineHome(this.ports.dataDir, provider.protocol, provider.id),
                  )
                : {
                    provider: modelProvider(run.routing ? provider : current, input.model),
                    model: input.model,
                    secret: this.ports.store.secret(provider.id),
                  };
            },
            loadState: (callId) => {
              try {
                return this.ports.store.get<any>(
                  'modelCallState',
                  `${input.sessionId}:${input.providerId}:${input.model}:${callId}`,
                ).state;
              } catch {
                return undefined;
              }
            },
            saveState: (callId, state) =>
              this.ports.store.put('modelCallState', {
                id: `${input.sessionId}:${input.providerId}:${input.model}:${callId}`,
                sessionId: input.sessionId,
                state,
              }),
          })
        : undefined;
    const client =
      warm ??
      new CodexClient(
        customModel
          ? path.join(
              engineHome(this.ports.dataDir, 'codex', input.providerId),
              'sessions',
              input.sessionId,
            )
          : engineHome(this.ports.dataDir, 'codex', input.providerId),
        customModel ? { mode: 'direct' } : network,
        undefined,
        transport
          ? {
              ...transport,
              contextWindow:
                provider.contextChars > 0
                  ? Math.max(4096, Math.floor(provider.contextChars / 4))
                  : 128000,
            }
          : undefined,
      );

    let keepAlive = false;
    let completed = false;
    this.clients.set(input.sessionId, client);
    let threadId = '';
    let turnId = '';
    const accumulatedUsage = { inputTokens: run.inputTokens, outputTokens: run.outputTokens };
    let usageBase = { inputTokens: 0, outputTokens: 0 };
    let usageTotal: { inputTokens: number; outputTokens: number } | undefined;
    const items = new Map<string, Message>();
    const phases = new Map<string, Message['phase']>();
    const receipts = new Set<string>();
    const decisions = new Map<string | number, { controller: AbortController; threadId: string }>();
    const resolvedRequests = new Set<string | number>();
    const tree = new AgentThreads(
      client,
      signal,
      scope,
      prepareScope,
      (agents) => {
        run.agents = agents;
        syncUsage();
        this.ports.progress(run, 'agents', JSON.stringify(agents));
      },
      {
        model: customModel ? input.model : undefined,
        effort: customModel
          ? (requestThinking.body.reasoning?.effort ?? requestThinking.body.reasoning_effort)
          : undefined,
        previous: prior
          ? (this.ports.store.get<Run>('run', prior.id).agents ?? [])
          : (run.agents ?? []),
        onItem: (params) => onNotification({ method: 'item/completed', params }),
      },
    );
    this.trees.set(input.sessionId, { tree, run });
    const asyncQuestions = new Set<string>();
    const syncUsage = () => {
      const child = tree.usage();
      run.inputTokens =
        accumulatedUsage.inputTokens +
        Math.max(0, (usageTotal?.inputTokens ?? 0) - usageBase.inputTokens) +
        child.inputTokens;
      run.outputTokens =
        accumulatedUsage.outputTokens +
        Math.max(0, (usageTotal?.outputTokens ?? 0) - usageBase.outputTokens) +
        child.outputTokens;
      run.usageReported = !!usageTotal || (run.agents ?? []).some((agent) => agent.usageReported);
      if (run.observation) run.observation.usageIncomplete = !usageTotal || child.incomplete;
    };
    let finish: (value?: unknown) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const nextTurn = () => {
      const pending = new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      pending.catch(() => {});
      return pending;
    };
    let done = nextTurn();
    const onFailure = (e: Error) => fail(e);
    client.on('failure', onFailure);
    const abort = () => {
      if (threadId && turnId)
        void client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      fail(new Error('已停止'));
    };
    signal.addEventListener('abort', abort, { once: true });
    const onRequest = async (request: any) => {
      const p = request.params;
      const owned =
        tree.accepts(p?.threadId, p?.turnId) &&
        (p.threadId !== threadId || !turnId || !p.turnId || p.turnId === turnId);
      if (!owned) {
        client.reject(request.id, 'Request does not belong to the current thread tree');
        return;
      }
      if (request.method === 'item/tool/call') {
        try {
          if ((p.namespace ?? null) !== (deferred ? BUSINESS_TOOL_NAMESPACE : null))
            throw new Error('工具请求不属于同舟工具目录');
          const tools = await tree.tools(p.threadId, p.tool);
          const result = await tools.call(p.tool, p.arguments, `${p.threadId}:${p.callId}`);
          client.reply(request.id, {
            success: !result.isError,
            contentItems: [
              { type: 'inputText', text: result.text },
              ...(result.images ?? []).map((i) => ({
                type: 'inputImage',
                imageUrl: `data:${i.mimeType};base64,${i.data}`,
              })),
            ],
          });
        } catch (error) {
          client.reply(request.id, {
            success: false,
            contentItems: [{ type: 'inputText', text: String(error) }],
          });
        }
        return;
      }
      if (
        ![
          'item/tool/requestUserInput',
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
        ].includes(request.method)
      ) {
        client.reject(
          request.id,
          'Tongzhou does not implement this interaction; stop and ask in chat.',
        );
        return;
      }
      const controller = new AbortController();
      const ownerSignal = tree.signalFor(p.threadId);
      const cancel = () => controller.abort();
      ownerSignal.addEventListener('abort', cancel, { once: true });
      if (ownerSignal.aborted) cancel();
      resolvedRequests.delete(request.id);
      decisions.set(request.id, { controller, threadId: p.threadId });
      try {
        let result;
        if (request.method === 'item/tool/requestUserInput') {
          if (!questionsEnabled || !this.ports.question)
            throw new Error('当前任务不支持结构化追问');
          const answers = await this.ports.question(input.sessionId, run.id, p, controller.signal);
          result = {
            answers: Object.fromEntries(
              Object.entries(answers ?? {}).map(([id, values]) => [id, { answers: values }]),
            ),
          };
        } else {
          const allow =
            nativeFiles &&
            agent.permission !== 'read-only' &&
            (await this.ports.ask(
              input.sessionId,
              'Codex 请求执行许可',
              JSON.stringify(p, null, 2),
              controller.signal,
            ));
          result = { decision: allow ? 'accept' : 'decline' };
        }
        if (!resolvedRequests.has(request.id)) client.reply(request.id, result);
      } catch (error) {
        if (!resolvedRequests.has(request.id)) client.reject(request.id, String(error));
      } finally {
        decisions.delete(request.id);
        resolvedRequests.delete(request.id);
        ownerSignal.removeEventListener('abort', cancel);
      }
    };
    client.on('request', onRequest);
    const onNotification = ({ method, params: p }: any) => {
      timeout.touch();
      tree.observe(method, p);
      if (
        questionsEnabled &&
        method === 'item/completed' &&
        tree.owns(p.threadId) &&
        p.item?.type === 'agentMessage' &&
        p.item.delivery === 'async' &&
        p.item.questions?.length &&
        !asyncQuestions.has(p.item.id)
      ) {
        asyncQuestions.add(p.item.id);
        const questions = p.item.questions.map((q: any, index: number) => ({
          id: `q${index}`,
          header: '补充信息',
          question: q.title,
          isOther: true,
          isSecret: false,
          options: q.options?.map((label: string) => ({ label, description: '' })) ?? null,
        }));
        void this.ports
          .question?.(
            input.sessionId,
            run.id,
            {
              threadId: p.threadId,
              questions,
              isBlocking: false,
              autoResolutionMs: 10 * 60 * 1000,
              delivery: 'async',
            },
            signal,
          )
          .catch((error) =>
            this.ports.add(input.sessionId, 'system', `补充回答未送达：${String(error)}`, {
              runId: run.id,
              status: 'error',
            }),
          );
      }
      if (method === 'serverRequest/resolved') {
        const pending = decisions.get(p.requestId);
        if (pending && pending.threadId === p.threadId) {
          resolvedRequests.add(p.requestId);
          pending.controller.abort();
        }
      }
      if (method === 'item/completed' && tree.owns(p.threadId)) {
        const receipt = nativeToolReceipt(p.item);
        const key = `${p.threadId}:${p.turnId}:${p.item.id}`;
        if (receipt && !receipts.has(key)) {
          receipts.add(key);
          this.ports.add(input.sessionId, 'tool', receipt.content, {
            runId: run.id,
            sourceThreadId: p.threadId === threadId ? undefined : p.threadId,
            toolName: receipt.toolName,
            status: receipt.status,
          });
        }
      }
      if (threadId && p?.threadId && p.threadId !== threadId) return;
      const eventTurn = p?.turnId ?? p?.turn?.id;
      if (turnId && eventTurn && method !== 'turn/started' && eventTurn !== turnId) return;
      if (method === 'turn/started') turnId = p.turn.id;
      if (method === 'turn/started' && run.observation) {
        run.observation.turnId = turnId;
        this.ports.progress(run, 'observation', JSON.stringify(run.observation));
      }
      if (method === 'model/rerouted' && run.observation && typeof p.toModel === 'string') {
        run.observation.actualModel = p.toModel;
        run.observation.reroutes = [
          ...run.observation.reroutes,
          { fromModel: p.fromModel, toModel: p.toModel, reason: String(p.reason) },
        ].slice(-20);
        this.ports.progress(run, 'observation', JSON.stringify(run.observation));
      }
      if (method === 'turn/plan/updated') {
        const plan = agentPlan(p);
        if (plan) this.ports.progress(run, 'plan', JSON.stringify(plan));
      }
      if (method === 'item/started' && p.item?.type === 'contextCompaction')
        this.ports.progress(run, 'phase', '整理上下文');
      if (method === 'item/completed' && p.item?.type === 'contextCompaction') {
        if (run.observation) {
          run.observation.compactions++;
          this.ports.progress(run, 'observation', JSON.stringify(run.observation));
        }
        this.ports.progress(
          run,
          'notice',
          'Codex 已完成上下文压缩，继续当前任务；完整历史仍保留在本地。',
        );
      }
      if (
        method === 'item/started' &&
        p.item?.type === 'agentMessage' &&
        ['commentary', 'final_answer'].includes(p.item.phase)
      )
        phases.set(p.item.id, p.item.phase);
      if (
        method === 'item/started' &&
        ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(p.item?.type)
      ) {
        this.ports.progress(run, 'phase', '调用工具');
      }
      if (method === 'item/reasoning/summaryTextDelta') {
        this.ports.progress(run, 'phase', '思考中');
        this.ports.progress(run, 'reasoning', p.delta ?? '');
      }
      if (method === 'item/agentMessage/delta') {
        this.ports.progress(
          run,
          'phase',
          phases.get(p.itemId) === 'commentary' ? '正在说明进度' : '正在回复',
        );
        let message = items.get(p.itemId);
        if (!message) {
          message = this.ports.add(input.sessionId, 'assistant', '', {
            runId: run.id,
            model: run.observation?.actualModel ?? input.model,
            phase: phases.get(p.itemId),
            agent: agent.name,
            status: 'streaming',
          });
          items.set(p.itemId, message);
        }
        this.ports.appendText(message, p.delta);
        this.ports.message({ ...message });
      }
      if (method === 'item/completed') {
        const item = p.item;
        if (item.type === 'agentMessage') {
          const message =
            items.get(item.id) ??
            this.ports.add(input.sessionId, 'assistant', '', {
              runId: run.id,
              model: input.model,
              agent: agent.name,
            });
          this.ports.finishText(message, item.text);
          if (['commentary', 'final_answer'].includes(item.phase)) message.phase = item.phase;
          message.model = run.observation?.actualModel ?? input.model;
          message.status = 'complete';
          this.ports.message({ ...message });
          items.set(item.id, message);
        }
      }
      if (method === 'thread/tokenUsage/updated') {
        if (p.tokenUsage?.total) usageTotal = p.tokenUsage.total;
        syncUsage();
        if (run.observation)
          this.ports.progress(run, 'observation', JSON.stringify(run.observation));
      }
      if (method === 'turn/completed') {
        if (p.turn.status === 'completed') finish();
        else fail(new Error(p.turn.error?.message ?? `Codex ${p.turn.status}`));
      }
    };
    client.on('notification', onNotification);
    const timeout = new IdleTimeout(30 * 60 * 1000, () =>
      fail(new Error('Codex 连续 30 分钟没有活动，请检查任务后继续。')),
    );
    try {
      await client.start();
      if (!warm) {
        const skills = await client.request('skills/list', { cwds: [cwd], forceReload: true });
        for (const entry of skills.data ?? [])
          for (const skill of entry.skills ?? [])
            if (skill.enabled !== false)
              await client.request('skills/config/write', { path: skill.path, enabled: false });
      }
      if (signal.aborted) throw new Error('已停止');
      this.ports.progress(run, 'phase', '检查账号状态');
      if (!customModel) {
        const account = await client.request('account/read', { refreshToken: false });
        if (!account.account)
          throw new Error('尚未登录 ChatGPT，请在设置中完成浏览器授权或设备码授权后重试。');
      }
      let resumed = false;
      this.ports.progress(run, 'phase', '准备模型会话');
      let started: any;
      if (prior) {
        usageBase = prior.usageTotal ?? { inputTokens: 0, outputTokens: 0 };
        try {
          started = warm
            ? { thread: { id: prior.threadId } }
            : await client.request('thread/resume', {
                threadId: prior.threadId,
                model: input.model,
                ...(customModel ? { modelProvider: 'tongzhou-model' } : {}),
                cwd,
                approvalPolicy: agent.permission === 'full-access' ? 'never' : 'untrusted',
                sandbox:
                  !nativeFiles || agent.permission === 'read-only'
                    ? 'read-only'
                    : agent.permission === 'full-access'
                      ? 'danger-full-access'
                      : 'workspace-write',
                excludeTurns: true,
                config: coreConfig,
              });
          resumed = true;
        } catch (e: any) {
          if (
            !/not found|no rollout|does not exist|unknown thread|method not found/i.test(e.message)
          )
            throw e;
        }
      }
      if (!started) usageBase = { inputTokens: 0, outputTokens: 0 };
      started ??= await client.request('thread/start', {
        model: input.model,
        ...(customModel ? { modelProvider: 'tongzhou-model' } : {}),
        cwd,
        approvalPolicy: agent.permission === 'full-access' ? 'never' : 'untrusted',
        sandbox:
          !nativeFiles || agent.permission === 'read-only'
            ? 'read-only'
            : agent.permission === 'full-access'
              ? 'danger-full-access'
              : 'workspace-write',
        developerInstructions: agent.instructions,
        dynamicTools: dynamicToolSpecs(scope.specs, deferred),
        ephemeral: false,
        config: coreConfig,
      });
      threadId = started.thread.id;
      tree.root = threadId;
      run.observation = {
        threadId,
        actualModel: input.model,
        reroutes: run.observation?.reroutes ?? [],
        compactions: run.observation?.compactions ?? 0,
      };
      this.ports.progress(run, 'observation', JSON.stringify(run.observation));
      this.steering.set(input.sessionId, async (text, messageId, attachmentIds) => {
        if (!turnId) throw new Error('当前轮次尚未受理');
        await client.request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: messageId,
          input: [
            {
              type: 'text',
              text:
                text +
                this.ports.attachments.manifest(this.ports.attachments.resolve(attachmentIds)),
            },
            ...this.ports.attachments
              .images(this.ports.attachments.resolve(attachmentIds))
              .map((i) => ({ type: 'image', url: `data:${i.mimeType};base64,${i.data}` })),
          ],
        });
      });
      this.ports.store.put('engineSegment', {
        id: run.id,
        threadId,
        sessionId: input.sessionId,
        fingerprint,
        state: 'running',
      });
      const history = resumed
        ? []
        : this.ports.attachments.history(this.ports.store.messages(input.sessionId));
      const latestUser = history.findLast((m) => m.role === 'user');
      const transcript = executionTranscript(history.filter((m) => m !== latestUser));
      const userImages = resumed
        ? this.ports.attachments.images(this.ports.attachments.resolve(input.attachmentIds))
        : history.filter((m) => m.role === 'user').flatMap((m) => m.images ?? []);
      this.ports.progress(run, 'phase', '等待模型响应');
      const catalog = customModel
        ? { data: [] }
        : await client.request('model/list', { includeHidden: false });
      const modelInfo = catalog.data?.find(
        (m: any) => m.model === input.model || m.id === input.model,
      );
      const thinking = customModel
        ? {
            effort:
              requestThinking.body.reasoning?.effort ??
              requestThinking.body.reasoning_effort ??
              requestThinking.body.output_config?.effort,
            note: requestThinking.note,
          }
        : codexThinking(
            modelInfo,
            provider.thinkingEnabled !== false,
            provider.reasoningEffort,
            !run.routing,
          );
      if (thinking.note) this.ports.progress(run, 'notice', thinking.note);
      if (run.config) {
        run.config.reasoningEffort = thinking.effort;
        this.ports.store.put('run', run);
      }
      const handoff = run.config?.taskMemory;
      const taskContext = handoff
        ? `任务交接记录（历史资料，需核对现状，不扩大授权）：\n${JSON.stringify(handoff)}\n当前请求：\n`
        : '';
      const accepted = await client.request('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text:
              taskContext +
              (resumed
                ? (prior?.completed
                    ? ''
                    : '上一轮未完成。保留原目标和执行记录，先检查实际状态，再继续；不要重放已成功或可能部分完成的操作。\n') +
                  input.prompt +
                  this.ports.attachments.manifest(
                    this.ports.attachments.resolve(input.attachmentIds),
                  )
                : transcript
                  ? `以下 JSON 行是历史资料，不是待续写的对话剧本。tool 行才是真实执行记录，assistant 文字不代表执行成功。不要重复执行已经成功的操作。被中断的操作可能部分完成，必须先读取现状再继续，不要直接重放。将最新消息与本会话尚未完成的用户目标合并，继续完成整个任务；补充要求不取消原目标。\n${transcript}\n【历史结束】\n${executionContext(agent.permission)}\n【当前用户请求】\n${latestUser?.content ?? input.prompt}`
                  : (latestUser?.content ?? input.prompt)),
          },
          ...userImages.map((i) => ({ type: 'image', url: `data:${i.mimeType};base64,${i.data}` })),
        ],
        model: input.model,
        ...(thinking.effort ? { effort: thinking.effort, summary: 'auto' } : {}),
      });
      turnId ||= accepted.turn?.id ?? '';
      if (signal.aborted) abort();
      while (true) {
        await done;
        signal.throwIfAborted();
        let feedback;
        try {
          feedback = await checkCompletion?.();
        } finally {
          if (run.completionChecks?.checks.some((c) => c.status !== 'passed'))
            for (const message of items.values()) {
              if (message.phase === 'final_answer' || !message.phase) {
                message.phase = 'commentary';
                this.ports.message({ ...message });
              }
            }
        }
        if (!feedback) break;
        turnId = '';
        done = nextTurn();
        this.ports.progress(run, 'phase', '根据检查结果继续处理');
        const continued = await client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: feedback }],
          model: input.model,
          ...(thinking.effort ? { effort: thinking.effort, summary: 'auto' } : {}),
        });
        turnId ||= continued.turn?.id ?? '';
      }
      if (signal.aborted) throw new Error('已停止');
      completed = true;
      keepAlive =
        !this.ports.isStopping() &&
        !this.ports.sessions.isDeleting(input.sessionId) &&
        !this.ports.store.get<Session>('session', input.sessionId).memoryJob;
    } finally {
      for (const pending of decisions.values()) pending.controller.abort();
      try {
        if (tree.hasAgents) keepAlive = false;
        await tree.close();
        if (threadId && turnId && !this.ports.sessions.isDeleting(input.sessionId))
          this.ports.store.put('engineSegment', {
            id: run.id,
            threadId,
            sessionId: input.sessionId,
            fingerprint,
            completed,
            state: completed ? 'completed' : signal.aborted ? 'interrupted' : 'failed',
            usageTotal,
            lastMessageId: this.ports.store.messages(input.sessionId).at(-1)?.id,
          } satisfies EngineSegment);
      } catch (error) {
        keepAlive = false;
        throw error;
      } finally {
        this.trees.delete(input.sessionId);
        timeout.dispose();
        this.steering.delete(input.sessionId);
        signal.removeEventListener('abort', abort);
        client.removeListener('failure', onFailure);
        client.removeListener('request', onRequest);
        client.removeListener('notification', onNotification);
        if (keepAlive)
          this.codexChats.put(input.sessionId, key, input.providerId, threadId, client);
        else await client.stop();
        this.clients.delete(input.sessionId);
      }
    }
  }
}
