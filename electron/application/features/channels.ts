import { z } from 'zod';
import { manual, operation } from '../../core/tools/client-commands';
import { botSchema } from '../../services/channels/bots';
import { channelSchema, notificationRuleSchema } from '../../services/channels/channels';
import { idSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const channelsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-channels',
  inject: ['tzIpc', 'tzStore', 'tzRuntime', 'tzBots', 'tzChannels', 'tzFeishu'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = ctx.tzRuntime;
    const bots = ctx.tzBots;
    const channels = ctx.tzChannels;
    const feishu = ctx.tzFeishu;
    register(
      'saveBot',
      operation('会话机器人', 'change', '新增或修改机器人配置，凭据在界面保存', [botSchema]),
      (b) => bots.save(b),
    );
    register(
      'deleteBot',
      operation('会话机器人', 'change', '删除机器人连接', [idSchema.describe('botId')], {
        confirmation: 'always',
      }),
      (raw) => {
        const id = idSchema.parse(raw);
        feishu.cancel(id);
        bots.remove(id);
      },
    );
    register(
      'restartBot',
      operation('会话机器人', 'change', '重新连接已有机器人', [idSchema.describe('botId')]),
      (id) => bots.restart(idSchema.parse(id)),
    );
    register(
      'onboardBot',
      manual('会话机器人', '飞书机器人扫码接入', 'connections', '需要用户扫码完成账号授权', [
        idSchema.describe('newBotId'),
        z.string().min(1).describe('name'),
      ]),
      (raw, rawName) => {
        const id = idSchema.parse(raw);
        if (bots.list().some((b) => b.id === id)) throw new Error('此机器人已存在');
        return feishu.onboard(id, z.string().min(1).max(100).parse(rawName), (c, secret) =>
          bots.authorize(c, secret),
        );
      },
    );
    register(
      'onboardFeishu',
      manual('渠道通知', '飞书应用扫码接入', 'connections', '需要用户扫码完成账号授权', [
        idSchema,
        z.string().min(1),
      ]),
      (id, name) => {
        idSchema.parse(id);
        if (store.list<any>('channel').some((c) => c.id === id))
          throw new Error('此渠道已存在，请创建新的授权连接');
        return feishu.onboard(id, z.string().min(1).max(100).parse(name));
      },
    );
    register(
      'cancelChannelLogin',
      operation('渠道通知', 'change', '取消渠道或机器人待完成的扫码授权', [idSchema]),
      (id) => feishu.cancel(idSchema.parse(id)),
    );
    register(
      'saveChannel',
      operation('渠道通知', 'change', '配置通知渠道或邮件，凭据在界面保存', [channelSchema]),
      (c) => {
        channels.save(c);
        feishu.cancel(c.id);
      },
    );
    register(
      'testEmail',
      operation('渠道通知', 'change', '验证 SMTP 连接与认证，不发送邮件', [
        idSchema.describe('channelId'),
      ]),
      (id) => channels.testEmail(idSchema.parse(id)),
    );
    register(
      'deleteChannel',
      operation('渠道通知', 'change', '删除通知渠道及关联规则', [idSchema.describe('channelId')], {
        confirmation: 'always',
      }),
      (id) => {
        idSchema.parse(id);
        feishu.cancel(id);
        channels.remove(id);
      },
    );
    register(
      'sendChannel',
      operation('渠道通知', 'change', '向用户指定的渠道发送准确内容，必须有明确发送要求', [
        idSchema.describe('channelId'),
        z.string().min(1).max(4000).describe('text'),
        idSchema.optional().describe('sessionId'),
      ]),
      (id, text, sessionId) =>
        channels.send(
          idSchema.parse(id),
          z.string().min(1).max(4000).parse(text),
          idSchema.optional().parse(sessionId),
        ),
    );
    register(
      'saveNotificationRule',
      operation('渠道通知', 'change', '保存轮次通知触发规则；须按用户要求设置通知目标和条件', [
        notificationRuleSchema,
      ]),
      (r) => channels.saveRule(r),
    );
    register(
      'deleteNotificationRule',
      operation('渠道通知', 'change', '删除通知规则', [idSchema.describe('ruleId')], {
        confirmation: 'always',
      }),
      (id) => {
        store.remove('notificationRule', idSchema.parse(id));
        runtime.changed();
      },
    );
  },
};
