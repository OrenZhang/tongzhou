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
import { networkKey } from '../../../src/shared/provider-network';
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
  ) {
    const provider = this.ports.store.get<Provider>('provider', input.providerId);
    const network = this.ports.resolveNetwork
      ? await this.ports.resolveNetwork(provider.network, run.id)
      : provider.network;
    if (signal.aborted) throw new Error('已停止');
    const session = this.ports.store.get<Session>('session', input.sessionId);
    const nativeFiles =
      !session.knowledgeJob &&
      !session.memoryJob &&
      (!input.botContext || botSettings(this.ports.store).mode === 'workbench');
    const cwd = sessionWorkspace(this.ports.store, this.ports.dataDir, input.sessionId);
    if (!project) await mkdir(cwd, { recursive: true });
    const fingerprint = JSON.stringify([
      'codex-core-v2-local-files',
      input.providerId,
      provider.protocol,
      provider.baseUrl,
      provider.auth,
      provider.contextChars,
      provider.maxOutputTokens,
      networkKey(provider.network),
      provider.thinkingEnabled !== false,
      input.model,
      cwd,
      agent.instructions,
      agent.permission,
      scope.specs,
    ]);
    const prior = this.ports.store
      .list<any>('engineSegment')
      .filter(
        (s) =>
          s.sessionId === input.sessionId &&
          s.fingerprint === fingerprint &&
          s.completed &&
          s.lastMessageId === this.ports.store.messages(input.sessionId).at(-2)?.id,
      )
      .at(-1);
    const coreConfig = {
      // Dynamic business tools return structured JSON. Keep their bounded payloads
      // intact; Codex's default small text truncation can split JSON mid-string.
      tool_output_token_limit: 32000,
      'features.multi_agent': false,
      'features.skip_host_skill_discovery': true,
      'features.default_mode_request_user_input': false,
      'features.shell_tool': nativeFiles && agent.permission !== 'read-only',
      'features.view_image': nativeFiles,
      'features.goals': !this.ports.store.get<Session>('session', input.sessionId).memoryJob,
      'features.apply_patch_freeform': nativeFiles && agent.permission !== 'read-only',
    };
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
                : { provider, model: input.model, secret: this.ports.store.secret(provider.id) };
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
    this.clients.set(input.sessionId, client);
    let threadId = '';
    let turnId = '';
    const accumulatedUsage = { inputTokens: run.inputTokens, outputTokens: run.outputTokens };
    let usageBase = { inputTokens: 0, outputTokens: 0 };
    let usageTotal: { inputTokens: number; outputTokens: number } | undefined;
    const items = new Map<string, Message>();
    let finish: (value?: unknown) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const done = new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    done.catch(() => {});
    const onFailure = (e: Error) => fail(e);
    client.on('failure', onFailure);
    const abort = () => {
      if (threadId && turnId)
        void client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      fail(new Error('已停止'));
    };
    signal.addEventListener('abort', abort, { once: true });
    const onRequest = async (request: any) => {
      if (request.method === 'item/tool/call') {
        try {
          if (request.params.threadId !== threadId || (turnId && request.params.turnId !== turnId))
            throw new Error('工具请求不属于当前会话');
          const result = await scope.call(
            request.params.tool,
            request.params.arguments,
            request.params.callId,
          );
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
        } catch (e) {
          client.reply(request.id, {
            success: false,
            contentItems: [{ type: 'inputText', text: String(e) }],
          });
        }
        return;
      }
      if (
        request.method === 'item/commandExecution/requestApproval' ||
        request.method === 'item/fileChange/requestApproval'
      ) {
        const allow =
          nativeFiles &&
          agent.permission !== 'read-only' &&
          (await this.ports.ask(
            input.sessionId,
            'Codex 请求执行许可',
            JSON.stringify(request.params, null, 2),
            signal,
          ));
        client.reply(request.id, { decision: allow ? 'accept' : 'decline' });
      } else
        client.reject(
          request.id,
          'Tongzhou does not implement this interaction; stop and ask in chat.',
        );
    };
    client.on('request', onRequest);
    const onNotification = ({ method, params: p }: any) => {
      timeout.touch();
      if (threadId && p?.threadId && p.threadId !== threadId) return;
      if (turnId && p?.turnId && p.turnId !== turnId) return;
      if (method === 'turn/started') turnId = p.turn.id;
      if (method === 'item/started' && p.item?.type === 'contextCompaction')
        this.ports.progress(run, 'phase', '整理上下文');
      if (method === 'item/completed' && p.item?.type === 'contextCompaction')
        this.ports.progress(
          run,
          'notice',
          'Codex 已完成上下文压缩，继续当前任务；完整历史仍保留在本地。',
        );
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
        this.ports.progress(run, 'phase', '正在回复');
        let message = items.get(p.itemId);
        if (!message) {
          message = this.ports.add(input.sessionId, 'assistant', '', {
            runId: run.id,
            model: input.model,
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
          message.status = 'complete';
          this.ports.message({ ...message });
          items.set(item.id, message);
        } else if (item.type === 'commandExecution')
          this.ports.add(
            input.sessionId,
            'tool',
            `${item.command}\n\n${item.aggregatedOutput ?? ''}\nexit: ${item.exitCode}`,
            { runId: run.id, toolName: 'Codex · 终端' },
          );
        else if (item.type === 'fileChange')
          this.ports.add(input.sessionId, 'tool', JSON.stringify(item.changes, null, 2), {
            runId: run.id,
            toolName: 'Codex · 文件变更',
          });
        else if (item.type === 'mcpToolCall')
          this.ports.add(
            input.sessionId,
            'tool',
            JSON.stringify(item.result ?? item.error, null, 2),
            {
              runId: run.id,
              toolName: `${item.server}/${item.tool}`,
            },
          );
      }
      if (method === 'thread/tokenUsage/updated') {
        const usage = p.tokenUsage?.total;
        run.usageReported = Boolean(usage);
        if (usage) {
          usageTotal = usage;
          run.inputTokens =
            accumulatedUsage.inputTokens + Math.max(0, usage.inputTokens - usageBase.inputTokens);
          run.outputTokens =
            accumulatedUsage.outputTokens +
            Math.max(0, usage.outputTokens - usageBase.outputTokens);
        }
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
        developerInstructions: project
          ? `${agent.instructions}\n${executionContext(agent.permission)}`
          : `${agent.instructions}\n${executionContext(agent.permission)}\n当前是未关联项目的普通聊天。工作目录是本会话专属目录。直接回答用户问题；本地文件读写、目录操作和补丁修改优先使用 Codex 原生工具，无需选择项目。用户指定绝对路径时按当前权限直接操作该位置；否则使用本会话工作目录。内容库、作品和配置仍调用同舟业务工具，禁止直接修改客户端数据库或内部索引。不要无关探索其他本地目录。${scope.specs.length ? '用户已启用本次提供的动态插件工具，允许在无项目会话调用这些工具；操作电脑后重新截图确认。' : ''}`,
        dynamicTools: scope.specs.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
        ephemeral: false,
        config: coreConfig,
      });
      threadId = started.thread.id;
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
      this.ports.store.put('engineSegment', { id: run.id, threadId, sessionId: input.sessionId });
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
        ? { note: thinkingRequest(provider, input.model).note }
        : codexThinking(modelInfo, provider.thinkingEnabled !== false);
      if (thinking.note) this.ports.progress(run, 'notice', thinking.note);
      await client.request('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: resumed
              ? input.prompt +
                this.ports.attachments.manifest(this.ports.attachments.resolve(input.attachmentIds))
              : transcript
                ? `以下 JSON 行是历史资料，不是待续写的对话剧本。tool 行才是真实执行记录，assistant 文字不代表执行成功。不要重复执行已经成功的操作。被中断的操作可能部分完成，必须先读取现状再继续，不要直接重放。将最新消息与本会话尚未完成的用户目标合并，继续完成整个任务；补充要求不取消原目标。\n${transcript}\n【历史结束】\n${executionContext(agent.permission)}\n【当前用户请求】\n${latestUser?.content ?? input.prompt}`
                : (latestUser?.content ?? input.prompt),
          },
          ...userImages.map((i) => ({ type: 'image', url: `data:${i.mimeType};base64,${i.data}` })),
        ],
        model: input.model,
        ...(thinking.effort ? { effort: thinking.effort, summary: 'auto' } : {}),
      });
      if (signal.aborted) abort();
      await done;
      if (signal.aborted) throw new Error('已停止');
      this.ports.store.put('engineSegment', {
        id: run.id,
        threadId,
        sessionId: input.sessionId,
        fingerprint,
        completed: true,
        usageTotal,
        lastMessageId: this.ports.store.messages(input.sessionId).at(-1)?.id,
      });
      keepAlive =
        !this.ports.isStopping() &&
        !this.ports.sessions.isDeleting(input.sessionId) &&
        !this.ports.store.get<Session>('session', input.sessionId).memoryJob;
    } finally {
      timeout.dispose();
      this.steering.delete(input.sessionId);
      signal.removeEventListener('abort', abort);
      client.removeListener('failure', onFailure);
      client.removeListener('request', onRequest);
      client.removeListener('notification', onNotification);
      if (keepAlive) this.codexChats.put(input.sessionId, key, input.providerId, threadId, client);
      else await client.stop();
      this.clients.delete(input.sessionId);
    }
  }
}
