import { BotNotifications } from '../bots/notifications';
import { botSchema, publicBot } from '../bots/config';
import { botSettings, botSettingsSchema } from '../bots/settings';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../storage/store';
import type { TaskService, ChangePublisher } from '../../core/task-contracts';
import type { BotConfig, Channel, Session, Run } from '../../../src/shared/types';
import { connectBot, type BotMessage } from './bot-transports';
import { BotTaskReplies } from '../bots/task-replies';
import type { Lifecycle } from '../../core/application-events';

type Connection = { close(): void };
export class Bots {
  readonly notifications: BotNotifications;
  private taskReplies: BotTaskReplies;
  private clients = new Map<string, { signature: string; connection: Connection }>();
  private disposed = false;
  constructor(
    private store: Store,
    private runtime: Pick<TaskService, 'enqueue' | 'cancel' | 'snapshot'> &
      Partial<Pick<TaskService, 'start' | 'isActive'>> &
      ChangePublisher,
    private connect: typeof connectBot = connectBot,
  ) {
    this.notifications = new BotNotifications(store);
    this.taskReplies = new BotTaskReplies(
      store,
      () => this.list(),
      () => runtime.changed(),
    );
  }
  notify(run: Run, event: Lifecycle) {
    return this.taskReplies.notify(run, event);
  }
  list(): BotConfig[] {
    return this.store.list<BotConfig>('bot').map((b) => publicBot(this.store, b));
  }
  saveSettings(raw: unknown) {
    const settings = botSettingsSchema.parse(raw);
    const provider = this.store
      .providers()
      .find((p) => p.id === settings.providerId && p.enabled !== false);
    if (!provider || !provider.models.includes(settings.model))
      throw new Error('请选择可用连接与模型');
    if (settings.defaultProjectId) this.store.get('project', settings.defaultProjectId);
    for (const run of this.store.list<Run>('run'))
      if (run.botContext && run.status === 'running') void this.runtime.cancel(run.sessionId);
    this.store.put('botSettings', { id: 'default', ...settings });
    this.runtime.changed();
  }
  save(raw: unknown) {
    const { secret, ...b } = botSchema.parse(raw);
    const old = this.list().find((x) => x.id === b.id);
    const identityChanged =
      !!old &&
      (old.kind !== b.kind ||
        old.appId !== b.appId ||
        old.domain !== b.domain ||
        old.apiBaseUrl !== b.apiBaseUrl);
    if (!secret && (identityChanged || !this.store.hasSecret('bot_' + b.id)))
      throw new Error('请填写机器人应用密钥');
    this.stop(b.id);
    if (old && (identityChanged || secret)) this.notifications.clear(old);
    if (identityChanged || secret)
      this.store.saveSecret('bot_weixin_cursor_' + b.id, undefined, true);
    this.store.saveSecret('bot_' + b.id, secret);
    this.store.put('bot', { ...b, status: 'connecting' });
    this.sync();
    this.runtime.changed();
  }
  authorize(c: Channel, secret: string) {
    this.save({
      id: c.id,
      name: c.name,
      kind: 'feishu',
      appId: c.appId,
      domain: c.domain,
      secret,
      allowedSenders: c.allowedSenders ?? [],
      allowedChats: [],
    });
  }
  migrateLegacy() {
    for (const c of this.store.list<Channel>('channel')) {
      if (
        c.kind !== 'feishu' ||
        !c.inbound ||
        !c.appId ||
        !c.sessionId ||
        !c.allowedSenders?.length
      )
        continue;
      const id = 'legacy-' + c.id;
      if (!this.list().some((b) => b.id === id))
        this.save({
          id,
          name: c.name,
          kind: 'feishu',
          appId: c.appId,
          domain: c.domain,
          secret: this.store.secret('channel_app_' + c.id),
          allowedSenders: c.allowedSenders,
          allowedChats: c.receiveIdType === 'chat_id' && c.receiveId ? [c.receiveId] : [],
        });
      this.store.put('channel', { ...c, inbound: false });
    }
  }
  remove(id: string) {
    const bot = this.list().find((b) => b.id === id);
    if (bot) this.notifications.clear(bot);
    this.stop(id);
    this.store.remove('bot', id);
    this.store.saveSecret('bot_' + id, undefined, true);
    this.store.saveSecret('bot_weixin_cursor_' + id, undefined, true);
    for (const kind of ['botBinding', 'botInbox', 'botSession'])
      for (const item of this.store.list<any>(kind))
        if (item.botId === id) this.store.remove(kind, item.id);
    this.runtime.changed();
  }
  private stop(id: string) {
    this.taskReplies.remove(id);
    for (const run of this.store.list<Run>('run'))
      if (run.botContext?.botId === id && run.status === 'running')
        void this.runtime.cancel(run.sessionId);
    const entry = this.clients.get(id);
    this.clients.delete(id);
    entry?.connection.close();
  }
  restart(id: string) {
    this.store.get('bot', id);
    this.stop(id);
    this.sync();
  }
  sync() {
    if (this.disposed) return;
    const configs = this.list();
    for (const [id, entry] of this.clients)
      if (!configs.some((b) => b.id === id && this.signature(b) === entry.signature)) this.stop(id);
    for (const b of configs) {
      if (this.clients.has(b.id)) continue;
      const signature = this.signature(b);
      const state = (status: BotConfig['status'], error?: string) => {
        if (this.disposed || this.clients.get(b.id)?.signature !== signature) return;
        const current = this.store.get<BotConfig>('bot', b.id);
        if (current.status === status && current.error === error) return;
        this.store.put('bot', { ...current, status, error });
        this.runtime.changed();
      };
      // Install identity before adapters can report state; stale callbacks cannot resurrect deleted bots.
      const entry = { signature, connection: { close() {} } };
      this.clients.set(b.id, entry);
      if (!b.allowedSenders.length) {
        state('error', '请在连接配置中添加允许用户，再保存连接');
        continue;
      }
      state('connecting');
      try {
        entry.connection = this.connect(
          b,
          this.store.secret('bot_' + b.id),
          (m) => this.receive(b.id, m),
          state,
          {
            load: () => this.store.secret('bot_weixin_cursor_' + b.id),
            save: (cursor) => {
              if (!this.disposed && this.clients.get(b.id)?.signature === signature)
                this.store.saveSecret('bot_weixin_cursor_' + b.id, cursor);
            },
          },
        );
      } catch {
        state('error', '连接未能启动，请检查机器人配置');
      }
    }
  }
  private signature(b: BotConfig) {
    const { status, error, lastMessageAt, hasSecret, ...config } = b;
    return (
      JSON.stringify(config) +
      createHash('sha256')
        .update(this.store.secret('bot_' + b.id))
        .digest('hex')
    );
  }
  async receive(botId: string, m: BotMessage): Promise<string | undefined> {
    const b = this.list().find((x) => x.id === botId);
    if (
      !b ||
      !b.allowedSenders.includes(m.sender) ||
      !m.id ||
      !m.sender ||
      !m.chat ||
      !m.text ||
      m.text.length > 12000 ||
      m.id.length > 500
    )
      return;
    if (m.group && !b.allowedChats.includes(m.chat)) return;
    const id = createHash('sha256')
      .update(JSON.stringify([botId, m.id]))
      .digest('hex');
    if (this.store.list<any>('botInbox').some((x) => x.id === id)) return;
    this.notifications.remember(b, m.sender, m.replyContext);
    this.store.put('botInbox', { id, botId, time: Date.now(), status: 'received' });
    this.store.put('bot', {
      ...b,
      hasSecret: undefined,
      status: 'connected',
      lastMessageAt: Date.now(),
    });
    this.runtime.changed();
    if (!m.text.trim().startsWith('/') || botSettings(this.store).mode === 'chat') {
      try {
        const reply = await this.chat(b, m);
        this.store.put('botInbox', { id, botId, time: Date.now(), status: 'handled' });
        return reply;
      } catch {
        this.store.put('botInbox', { id, botId, time: Date.now(), status: 'failed' });
        return '暂时未能处理消息，请在同舟的机器人模块检查模型连接和运行记录。';
      }
    }
    const bindingId = createHash('sha256')
      .update(JSON.stringify([botId, m.sender, m.chat]))
      .digest('hex');
    const sessions = this.store
      .list<Session>('session')
      .filter(
        (s) =>
          !s.archived &&
          !s.parentId &&
          (!s.botConversation ||
            (s.botConversation.botId === b.id &&
              s.botConversation.sender === m.sender &&
              s.botConversation.chat === m.chat)),
      );
    const selected =
      this.store.list<any>('botBinding').find((x) => x.id === bindingId)?.sessionId ??
      (sessions.length === 1 ? sessions[0].id : undefined);
    const command = m.text
      .trim()
      .replace(/^@\S+\s+/, '')
      .match(/^\/?(\S+)(?:\s+([\s\S]*))?$/);
    let name = command?.[1].toLowerCase(),
      arg = command?.[2]?.trim() ?? '';
    const knownCommands = [
      'sessions',
      '会话',
      '列表',
      'help',
      '帮助',
      'status',
      '进度',
      'use',
      '切换',
      'new',
      'run',
      'stop',
      'rename',
      'archive',
      '新建',
      '继续',
      '停止',
    ];
    if (m.reply && !m.text.trim().startsWith('/') && !knownCommands.includes(name ?? '')) {
      name = 'run';
      arg = m.text.trim();
    }
    const lookup = (value: string) => {
      const found = sessions.filter((s) => s.id === value || s.id.startsWith(value));
      return found.length === 1 ? found[0] : undefined;
    };
    const describe = (s: Session) => {
      const run = this.store
        .list<Run>('run')
        .filter((r) => r.sessionId === s.id)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      return `${s.id.slice(0, 8)} · ${s.title.replace(/[\r\n]/g, ' ').slice(0, 100)} · ${run ? { running: '进行中', completed: '已完成', failed: '失败', interrupted: '已停止' }[run.status] : '待开始'}${run?.status === 'running' ? `（${Math.floor((Date.now() - run.startedAt) / 1000)} 秒）` : ''}`;
    };
    const help =
      '同舟机器人\n/sessions 会话列表\n/status [会话ID] 进度\n/use 会话ID 切换\n/new 标题 新建\n/run 任务内容 继续任务\n/stop 停止\n/rename 标题 重命名\n/archive 归档\n执行操作需要在同舟中开启权限。';
    try {
      let reply: string;
      if (['sessions', '会话', '列表'].includes(name ?? ''))
        reply = sessions.length
          ? sessions.slice(0, 40).map(describe).join('\n') +
            '\n使用 /use 会话ID 选择；/status 查看进度。'
          : '范围内暂无会话。';
      else if (['help', '帮助'].includes(name ?? '')) reply = help;
      else if (['status', '进度'].includes(name ?? '')) {
        const s = lookup(arg || selected || '');
        reply = s
          ? describe(s) +
            (this.runtime.snapshot().approvals.some((a) => a.sessionId === s.id)
              ? '\n等待本机批准。'
              : '')
          : '请先 /use 会话ID，或 /sessions 查看可见会话。';
      } else if (['use', '切换'].includes(name ?? '')) {
        const s = lookup(arg);
        if (!s) reply = '会话不存在、ID 不唯一或不在授权范围。';
        else {
          this.store.put('botBinding', { id: bindingId, botId, sessionId: s.id });
          reply = '当前会话：' + describe(s);
        }
      } else if (
        ['new', 'run', 'stop', 'rename', 'archive', '新建', '继续', '停止'].includes(name ?? '')
      ) {
        if (botSettings(this.store).permission === 'read-only')
          return '此机器人仅允许查看。请在同舟的机器人通用设置中调整执行模式。';
        if (name === 'new' || name === '新建') {
          if (!arg || arg.length > 120) return '用法：/new 会话标题（最多 120 字）';
          const s = this.store.createSession(botSettings(this.store).defaultProjectId);
          s.title = arg;
          s.permission = 'ask';
          this.store.put('session', s);
          this.store.put('botSession', { id: randomUUID(), botId, sessionId: s.id });
          this.store.put('botBinding', { id: bindingId, botId, sessionId: s.id });
          reply =
            '已创建并选择：' + describe(s) + '\n请在本机为会话选择连接和模型后，用 /run 发送任务。';
        } else {
          const s = lookup(selected || '');
          if (!s) return '请先 /use 会话ID。';
          if (name === 'run' || name === '继续') {
            if (!arg) return '用法：/run 任务内容';
            if (!s.model || !s.providerId) return '请先在本机为此会话选择模型连接。';
            const input = {
              sessionId: s.id,
              botContext: {
                botId: b.id,
                sender: m.sender,
                chat: m.chat,
                group: m.group,
                conversationId: s.id,
              },
              providerId: botSettings(this.store).providerId || s.providerId,
              model: botSettings(this.store).model || s.model,
              agentId: s.agentId,
              prompt: `[来自 ${b.name} 的授权用户]\n${arg}`,
            };
            if (m.reply && this.runtime.start) {
              if (this.runtime.isActive?.(s.id))
                return '当前会话正在执行任务，请等回复，或使用 /status、/stop。';
              const runId = this.runtime.start(input);
              this.taskReplies.register(runId, botId, m.sender, s.id, m.reply);
              reply = '任务已提交，完成后会在这里回复。需要批准时请回到同舟。';
            } else {
              await this.runtime.enqueue(input, 'supplement');
              reply = '任务已提交；使用 /status 查看进度。需要批准时请回到同舟。';
            }
          } else if (name === 'stop' || name === '停止') {
            this.runtime.cancel(s.id);
            reply = '已请求停止当前会话。';
          } else if (name === 'rename') {
            if (!arg || arg.length > 120) return '标题需要 1–120 字';
            this.store.put('session', { ...s, title: arg, updatedAt: Date.now() });
            reply = '会话已重命名。';
          } else {
            if (
              this.store
                .list<Run>('run')
                .some((r) => r.sessionId === s.id && r.status === 'running')
            )
              return '请先停止当前任务再归档。';
            this.store.put('session', { ...s, archived: true, updatedAt: Date.now() });
            reply = '会话已归档；可在本机恢复。';
          }
        }
        this.runtime.changed();
      } else reply = help;
      this.store.put('botInbox', { id, botId, time: Date.now(), status: 'handled' });
      return reply.slice(0, 6000);
    } catch {
      this.store.put('botInbox', { id, botId, time: Date.now(), status: 'failed' });
      return '操作未完成，请在本机查看连接、会话和权限状态；未自动重试。';
    }
  }
  private async chat(bot: BotConfig, message: BotMessage) {
    const settings = botSettings(this.store);
    if (!settings.providerId || !settings.model)
      return '请在同舟 → 机器人 → 通用设置中选择模型，设置一次即可开始聊天。';
    const provider = this.store
      .providers()
      .find((p) => p.id === settings.providerId && p.enabled !== false);
    if (!provider || !provider.models.includes(settings.model))
      return '机器人使用的模型已不可用，请在同舟 → 机器人 → 通用设置中重新选择。';
    let session = this.store
      .list<Session>('session')
      .find(
        (s) =>
          !s.archived &&
          s.botConversation?.botId === bot.id &&
          s.botConversation.sender === message.sender &&
          s.botConversation.chat === message.chat,
      );
    if (session && this.runtime.isActive?.(session.id))
      return '上一条请求还在处理，完成后会在这里回复。';
    if (!session) {
      session = this.store.createSession(
        settings.mode === 'workbench' ? settings.defaultProjectId : undefined,
      );
      session.title = `${bot.name} · ${message.text.trim().slice(0, 24)}`;
      session.botConversation = {
        botId: bot.id,
        sender: message.sender,
        chat: message.chat,
        group: message.group,
      };
      this.store.put('session', session);
    }
    session = {
      ...session,
      providerId: settings.providerId,
      model: settings.model,
      permission: settings.mode === 'chat' ? 'read-only' : settings.permission,
      ...(settings.mode === 'chat' ? { projectId: null } : {}),
    };
    this.store.put('session', session);
    if (!this.runtime.start || !message.reply)
      return '此连接暂不支持持续对话，请更新客户端后重新连接。';
    const runId = this.runtime.start({
      sessionId: session.id,
      providerId: settings.providerId,
      model: settings.model,
      agentId: '',
      prompt: message.text.trim(),
      botContext: { ...session.botConversation!, conversationId: session.id },
    });
    this.taskReplies.register(
      runId,
      bot.id,
      message.sender,
      session.id,
      message.reply,
      message.typing,
    );
    this.runtime.changed();
    return undefined;
  }
  dispose() {
    this.disposed = true;
    for (const id of this.clients.keys()) this.stop(id);
  }
}
