import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { idSchema } from './validation';
import { feishuHost, feishuToken } from './feishu';
import nodemailer from 'nodemailer';
import type { Channel, Delivery, NotificationRule, Run, Session } from '../src/shared/types';

const configSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['feishu', 'wecom', 'dingtalk', 'email']),
  password: z.string().max(4000).optional(),
  smtp: z
    .object({
      host: z
        .string()
        .trim()
        .min(1)
        .max(253)
        .regex(/^[a-zA-Z0-9.-]+$/),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
      user: z.string().trim().max(300),
      from: z.email().max(320),
      to: z.array(z.email().max(320)).min(1).max(50),
      subject: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[^\r\n]+$/),
    })
    .optional(),
  enabled: z.boolean(),
  webhook: z.string().max(3000).optional(),
  signingSecret: z.string().max(1000).optional(),
  mode: z.enum(['webhook', 'app']).default('webhook'),
  appId: z.string().max(100).optional(),
  domain: z.enum(['feishu', 'lark']).optional(),
  receiveId: z.string().max(150).optional(),
  receiveIdType: z.enum(['chat_id', 'open_id']).optional(),
  inbound: z.boolean().optional(),
  sessionId: idSchema.optional(),
  allowedSenders: z.array(z.string().min(1).max(150)).max(50).optional(),
});
const ruleSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  sessionId: idSchema.nullable(),
  enabled: z.boolean(),
  once: z.boolean(),
  events: z.array(z.enum(['completed', 'failed', 'interrupted', 'approval', 'ended'])).min(1),
  projectId: idSchema.optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  minDurationSeconds: z.number().min(0).max(604800).optional(),
  targetRunId: idSchema.optional(),
  template: z.string().min(1).max(1500),
});
const hosts = {
  feishu: ['open.feishu.cn', 'open.larksuite.com'],
  wecom: ['qyapi.weixin.qq.com'],
  dingtalk: ['oapi.dingtalk.com'],
};
export function webhookUrl(kind: Channel['kind'], value: string) {
  if (kind === 'email') throw new Error('邮件请配置 SMTP');
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    !hosts[kind].includes(u.hostname)
  )
    throw new Error('请填写此平台官方机器人的 HTTPS Webhook');
  if (
    !(
      kind === 'feishu'
        ? /^\/open-apis\/bot\/v2\/hook\/[^/]+$/
        : kind === 'wecom'
          ? /^\/cgi-bin\/webhook\/send$/
          : /^\/robot\/send$/
    ).test(u.pathname)
  )
    throw new Error('Webhook 路径不正确');
  if (
    (kind === 'wecom' && !u.searchParams.get('key')) ||
    (kind === 'dingtalk' && !u.searchParams.get('access_token'))
  )
    throw new Error('Webhook 缺少访问凭据');
  return u;
}
export class Channels {
  private disposed = false;
  private controllers = new Map<string, AbortController>();
  constructor(
    private store: Store,
    private changed: () => void,
    private transport: typeof fetch = fetch,
    private mailer: typeof nodemailer.createTransport = nodemailer.createTransport,
  ) {
    for (const d of store.list<Delivery>('delivery'))
      if (d.status === 'sending')
        store.put('delivery', {
          ...d,
          status: 'unknown',
          error: '应用在发送期间退出，结果未知；未自动重发',
        });
  }
  list() {
    return this.store.list<Channel>('channel');
  }
  save(raw: unknown) {
    const { webhook, signingSecret, password, ...c } = configSchema.parse(raw);
    const old = this.list().find((o) => o.id === c.id);
    if (old && old.kind !== c.kind) throw new Error('请为不同平台创建新的通知目标');
    if (c.kind === 'email') {
      if (!c.smtp) throw new Error('请配置 SMTP 服务器和收件人');
      const identityChanged =
        old?.smtp?.host !== c.smtp.host ||
        old?.smtp?.port !== c.smtp.port ||
        old?.smtp?.secure !== c.smtp.secure ||
        old?.smtp?.user !== c.smtp.user;
      if (
        c.smtp.user &&
        !password &&
        (identityChanged || !this.store.hasSecret('channel_mail_' + c.id))
      )
        throw new Error('请填写邮箱密码或授权码');
      this.abort(c.id);
      this.store.saveSecret('channel_mail_' + c.id, password, !c.smtp.user);
      this.store.put('channel', { ...c, status: 'configured' });
      this.changed();
      return;
    }
    if (c.mode === 'app') {
      if (
        c.kind !== 'feishu' ||
        old?.mode !== 'app' ||
        old.appId !== c.appId ||
        !this.store.hasSecret('channel_app_' + c.id)
      )
        throw new Error('请先扫码授权飞书应用');
      if (!c.receiveId) throw new Error('请填写通知收件人或群 ID');
      if (c.inbound && (!c.sessionId || !c.allowedSenders?.length))
        throw new Error('接收消息需要绑定会话和发送人白名单');
      if (c.sessionId) this.store.get('session', c.sessionId);
      this.abort(c.id);
      this.store.put('channel', { ...c, status: old.status, checkedAt: old.checkedAt });
      this.changed();
      return;
    }
    if (webhook) webhookUrl(c.kind, webhook);
    if (!webhook && (!old || old.kind !== c.kind)) throw new Error('请填写此渠道的 Webhook');
    const stored = webhook || this.store.secret('channel_url_' + c.id);
    webhookUrl(c.kind, stored);
    this.abort(c.id);
    this.store.saveSecret('channel_url_' + c.id, webhook);
    this.store.saveSecret('channel_sign_' + c.id, signingSecret, signingSecret === '');
    this.store.put('channel', {
      ...c,
      status: webhook || signingSecret !== undefined ? 'configured' : (old?.status ?? 'configured'),
      checkedAt: old?.checkedAt,
    });
    this.changed();
  }
  remove(id: string) {
    this.abort(id);
    this.store.remove('channel', id);
    for (const prefix of ['channel_url_', 'channel_sign_', 'channel_app_', 'channel_mail_'])
      this.store.saveSecret(prefix + id, undefined, true);
    for (const r of this.store.list<NotificationRule>('notificationRule'))
      if (r.channelId === id) this.store.remove('notificationRule', r.id);
    this.changed();
  }
  saveRule(raw: unknown) {
    const r = ruleSchema.parse(raw);
    this.store.get('channel', r.channelId);
    if (r.sessionId) this.store.get('session', r.sessionId);
    if (r.projectId) this.store.get('project', r.projectId);
    if (r.targetRunId && r.enabled) {
      const run = this.store.get<Run>('run', r.targetRunId);
      if (run.status !== 'running' || run.sessionId !== r.sessionId || !r.once)
        throw new Error('本轮提醒需要仍在运行的会话和一次性规则');
    }
    if (/\{(?!title\}|status\}|model\}|time\})/.test(r.template))
      throw new Error('模板仅支持 {title}、{status}、{model}、{time}');
    this.store.put('notificationRule', r);
    this.changed();
  }
  async notify(run: Run, event: NotificationRule['events'][number], eventId = run.id) {
    const session = this.store.list<Session>('session').find((s) => s.id === run.sessionId);
    if (!session) return;
    for (const rule of this.store.list<NotificationRule>('notificationRule')) {
      if (
        !rule.enabled ||
        !(rule.events.includes(event) || (event !== 'approval' && rule.events.includes('ended'))) ||
        (rule.sessionId && rule.sessionId !== session.id) ||
        (rule.projectId && rule.projectId !== session.projectId) ||
        (rule.models?.length && !rule.models.includes(run.model)) ||
        (rule.targetRunId && rule.targetRunId !== run.id) ||
        (rule.minDurationSeconds &&
          ((run.endedAt ?? Date.now()) - run.startedAt) / 1000 < rule.minDurationSeconds)
      )
        continue;
      const text = rule.template.replace(
        /\{(title|status|model|time)\}/g,
        (_, k) =>
          ({
            title: session.title,
            status: {
              completed: '完成',
              failed: '失败',
              interrupted: '已停止',
              approval: '等待批准',
              ended: '轮次结束',
            }[event],
            model: run.model,
            time: new Date().toLocaleString('zh-CN'),
          })[k as 'title'] ?? '',
      );
      try {
        await this.send(
          rule.channelId,
          text,
          session.id,
          `${rule.id}:${eventId}:${event}`,
          rule.id,
        );
      } catch {
        /* result is persisted; no unattended retries */
      }
    }
  }
  async send(
    id: string,
    text: string,
    sessionId?: string,
    key: string = randomUUID(),
    ruleId?: string,
  ) {
    z.string().min(1).max(4000).parse(text);
    if (sessionId) this.store.get('session', sessionId);
    const c = this.store.get<Channel>('channel', id);
    if (!c.enabled) throw new Error('渠道已停用');
    const prior = this.store
      .list<Delivery>('delivery')
      .find((d) => d.channelId === id && d.key === key);
    if (prior) return prior;
    let url =
      c.kind === 'email'
        ? undefined
        : c.mode === 'app'
          ? new URL(
              feishuHost(c.domain) +
                '/open-apis/im/v1/messages?receive_id_type=' +
                (c.receiveIdType ?? 'open_id'),
            )
          : webhookUrl(c.kind, this.store.secret('channel_url_' + id));
    const secret = this.store.secret('channel_sign_' + id);
    const d: Delivery = {
      id: randomUUID(),
      channelId: id,
      sessionId,
      key,
      ruleId,
      time: Date.now(),
      status: 'sending',
    };
    this.store.put('delivery', d);
    // Consume a one-shot rule at dispatch, even when the network result is unknown.
    if (ruleId) {
      const rule = this.store.get<NotificationRule>('notificationRule', ruleId);
      if (rule.once) this.store.put('notificationRule', { ...rule, enabled: false });
    }
    const controller = new AbortController();
    this.controllers.set(d.id, controller);
    this.changed();
    let dispatched = false;
    try {
      if (c.kind === 'email') {
        const mail = this.emailTransport(c);
        const abort = () => mail.close();
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
          controller.signal.throwIfAborted();
          dispatched = true;
          const result = await mail.sendMail({
            from: c.smtp!.from,
            to: c.smtp!.to,
            subject: c.smtp!.subject,
            text,
            messageId: `<${d.id}@tongzhou.local>`,
            disableFileAccess: true,
            disableUrlAccess: true,
          });
          if (result.rejected?.length) {
            d.status = 'failed';
            throw new Error('平台仅接受了部分收件人；请查看邮箱后再决定是否重发');
          }
          if (!result.accepted?.length) {
            d.status = 'failed';
            throw new Error('平台未接受邮件收件人');
          }
          d.status = 'sent';
          if (!this.disposed && this.list().some((x) => x.id === id))
            this.store.put('channel', {
              ...this.store.get<Channel>('channel', id),
              status: 'connected',
              checkedAt: Date.now(),
            });
        } catch (error: any) {
          if (
            ['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(error.code) ||
            (error.responseCode >= 500 && error.responseCode < 600)
          )
            d.status = 'failed';
          throw error;
        } finally {
          controller.signal.removeEventListener('abort', abort);
          mail.close();
        }
        return d;
      }
      const body: any =
        c.mode === 'app'
          ? {
              receive_id: c.receiveId,
              msg_type: 'text',
              content: JSON.stringify({ text }),
              uuid: d.id,
            }
          : c.kind === 'feishu'
            ? { msg_type: 'text', content: { text } }
            : { msgtype: 'text', text: { content: text } };
      const auth =
        c.mode === 'app'
          ? await feishuToken(
              c.appId!,
              this.store.secret('channel_app_' + id),
              c.domain,
              AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
            )
          : '';
      controller.signal.throwIfAborted();
      if (secret && c.kind === 'feishu') {
        body.timestamp = String(Math.floor(Date.now() / 1000));
        body.sign = createHmac('sha256', body.timestamp + '\n' + secret)
          .update('')
          .digest('base64');
      }
      if (secret && c.kind === 'dingtalk') {
        const t = String(Date.now());
        url!.searchParams.set('timestamp', t);
        url!.searchParams.set(
          'sign',
          createHmac('sha256', secret)
            .update(t + '\n' + secret)
            .digest('base64'),
        );
      }
      dispatched = true;
      const response = await this.transport(url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      if (!response.ok) {
        d.status = response.status >= 500 ? 'unknown' : 'failed';
        throw new Error(`平台返回 HTTP ${response.status}`);
      }
      const result = (await response.json()) as any;
      const code = c.kind === 'feishu' ? (result.code ?? result.StatusCode) : result.errcode;
      if (code !== 0) {
        d.status = 'failed';
        throw new Error('平台未确认发送成功，错误码：' + String(code ?? 'missing'));
      }
      d.status = 'sent';
      if (!this.disposed && this.list().some((x) => x.id === id))
        this.store.put('channel', {
          ...this.store.get<Channel>('channel', id),
          status: 'connected',
          checkedAt: Date.now(),
        });
    } catch (e) {
      if (d.status === 'sending') d.status = dispatched ? 'unknown' : 'failed';
      d.error =
        e instanceof Error && /^(平台)/.test(e.message) ? e.message : '发送未获得确认，未自动重试';
    } finally {
      this.controllers.delete(d.id);
      if (!this.disposed) {
        if (!sessionId || this.store.list<Session>('session').some((s) => s.id === sessionId))
          this.store.put('delivery', d);
        this.changed();
      }
    }
    return d;
  }
  abort(id: string) {
    for (const d of this.store.list<Delivery>('delivery'))
      if (d.channelId === id || d.sessionId === id) this.controllers.get(d.id)?.abort();
  }
  private emailTransport(c: Channel) {
    if (c.kind !== 'email' || !c.smtp) throw new Error('邮件配置不存在');
    const s = c.smtp;
    return this.mailer({
      host: s.host,
      port: s.port,
      secure: s.secure,
      requireTLS: !s.secure,
      auth: s.user ? { user: s.user, pass: this.store.secret('channel_mail_' + c.id) } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  }
  async testEmail(id: string) {
    const c = this.store.get<Channel>('channel', id);
    if (!c.enabled) throw new Error('渠道已停用');
    const mail = this.emailTransport(c);
    try {
      await mail.verify();
      return 'SMTP 连接与认证通过；尚未发送邮件';
    } catch {
      throw new Error('SMTP 验证失败，请检查服务器、端口、TLS 和邮箱授权码');
    } finally {
      mail.close();
    }
  }
  dispose() {
    this.disposed = true;
    for (const c of this.controllers.values()) c.abort();
  }
}
