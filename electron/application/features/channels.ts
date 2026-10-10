import { z } from 'zod';
import { manual, operation } from '../../core/tools/client-commands';
import { channelSchema, notificationRuleSchema } from '../../services/channels/channels';
import { idSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const channelsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-channels',
  inject: ['tzIpc', 'tzStore', 'tzChannels', 'tzFeishu', 'tzEvents'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const channels = ctx.tzChannels;
    const feishu = ctx.tzFeishu;
    register(
      'notificationTargets',
      operation(
        '渠道通知',
        'query',
        '列出可用于即时消息、会话结束提醒和定时任务的通知目标，包括机器人连接；多个接收人时需向用户确认目标',
      ),
      () => channels.notificationTargets(),
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
      operation('渠道通知', 'change', '取消渠道待完成的扫码授权', [idSchema]),
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
      operation(
        '渠道通知',
        'change',
        '向 notificationTargets 返回的目标发送准确内容（含微信和飞书机器人）；必须有用户明确发送要求，定时任务也复用此方法',
        [
          idSchema.describe('channelId'),
          z.string().min(1).max(4000).describe('text'),
          idSchema.optional().describe('sessionId'),
        ],
      ),
      (id, text, sessionId) =>
        channels.send(
          idSchema.parse(id),
          z.string().min(1).max(4000).parse(text),
          idSchema.optional().parse(sessionId),
        ),
    );
    register(
      'saveNotificationRule',
      operation(
        '渠道通知',
        'change',
        '保存会话结束通知；channelId 从 notificationTargets 查询。仅本轮使用当前 targetRunId、sessionId、once=true；须按用户要求设置接收人和条件',
        [notificationRuleSchema],
      ),
      (r) => channels.saveRule(r),
    );
    register(
      'deleteNotificationRule',
      operation('渠道通知', 'change', '删除通知规则', [idSchema.describe('ruleId')], {
        confirmation: 'always',
      }),
      (id) => {
        store.remove('notificationRule', idSchema.parse(id));
        ctx.tzEvents.changed();
      },
    );
  },
};
