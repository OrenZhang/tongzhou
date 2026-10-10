import { DingtalkOnboarding } from '../../services/bots/dingtalk-onboarding';
import { botSettingsSchema } from '../../services/bots/settings';
import { z } from 'zod';
import { manual, operation } from '../../core/tools/client-commands';
import { botSchema } from '../../services/bots/config';
import { WecomOnboarding } from '../../services/bots/wecom-onboarding';
import { WeixinOnboarding } from '../../services/bots/weixin/onboarding';
import { idSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const botsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-bots',
  inject: ['tzIpc', 'tzBots', 'tzFeishu', 'tzStore', 'tzEvents'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const bots = ctx.tzBots;
    const feishu = ctx.tzFeishu;
    const wecom = new WecomOnboarding((state) => {
      ctx.tzStore.put('channelAuth', state);
      ctx.tzEvents.changed();
    });
    ctx.effect(() => () => wecom.dispose());
    const weixin = new WeixinOnboarding((state) => {
      ctx.tzStore.put('channelAuth', state);
      ctx.tzEvents.changed();
    });
    ctx.effect(() => () => weixin.dispose());
    const dingtalk = new DingtalkOnboarding((state) => {
      ctx.tzStore.put('channelAuth', state);
      ctx.tzEvents.changed();
    });
    ctx.effect(() => () => dingtalk.dispose());
    register(
      'saveBotSettings',
      manual(
        '机器人设置',
        '配置机器人共用模型与执行模式',
        'connections',
        '由用户在渠道的机器人通用设置中配置，Agent 不能自行提高权限',
        [botSettingsSchema],
      ),
      (settings) => bots.saveSettings(settings),
    );
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
        wecom.cancel(id);
        weixin.cancel(id);
        dingtalk.cancel(id);
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
      manual('会话机器人', '机器人扫码接入', 'connections', '需要用户扫码完成账号授权', [
        idSchema.describe('newBotId'),
        z.string().min(1).describe('name'),
        z.enum(['feishu', 'wecom', 'weixin', 'dingtalk']).describe('platform'),
      ]),
      (raw, rawName, rawKind) => {
        const id = idSchema.parse(raw);
        const name = z.string().trim().min(1).max(100).parse(rawName);
        const kind = z.enum(['feishu', 'wecom', 'weixin', 'dingtalk']).parse(rawKind);
        const existing = bots.list().find((b) => b.id === id);
        if (existing && (kind !== 'weixin' || existing.kind !== 'weixin'))
          throw new Error('此机器人已存在');
        feishu.cancel(id);
        wecom.cancel(id);
        weixin.cancel(id);
        dingtalk.cancel(id);
        if (kind === 'weixin')
          return weixin.onboard(id, (login) => {
            const current = bots.list().find((b) => b.id === id);
            if (
              existing &&
              (!current || current.kind !== 'weixin' || current.appId !== login.ilink_bot_id)
            )
              throw new Error('重新授权必须使用原微信账号');
            if (!existing && current) throw new Error('此机器人已存在');
            if (
              bots
                .list()
                .some((b) => b.id !== id && b.kind === 'weixin' && b.appId === login.ilink_bot_id)
            )
              throw new Error('微信机器人已添加，请在原机器人上重新扫码');
            bots.save({
              id,
              name: current?.name ?? name,
              kind,
              appId: login.ilink_bot_id,
              apiBaseUrl: login.baseurl,
              secret: login.bot_token,

              allowedSenders: [login.ilink_user_id],
              allowedChats: [],
            });
          });
        if (kind === 'dingtalk')
          return dingtalk.onboard(id, ({ client_id, client_secret }) => {
            if (
              bots
                .list()
                .some((b) => b.id === id || (b.kind === 'dingtalk' && b.appId === client_id))
            )
              throw new Error('此钉钉机器人已存在，请管理已有连接');
            bots.save({
              id,
              name,
              kind,
              appId: client_id,
              secret: client_secret,
              allowedSenders: [],
              allowedChats: [],
            });
          });
        if (kind === 'wecom')
          return wecom.onboard(id, ({ botid, secret }) => {
            if (bots.list().some((b) => b.id === id)) throw new Error('此机器人已存在');
            bots.save({
              id,
              name,
              kind,
              appId: botid,
              secret,

              allowedSenders: [],
              allowedChats: [],
            });
          });
        return feishu.onboard(id, name, (c, secret) => bots.authorize(c, secret));
      },
    );
    register(
      'verifyBotLogin',
      manual(
        '会话机器人',
        '提交微信扫码验证码',
        'connections',
        '需要用户输入手机微信显示的验证码',
        [idSchema, z.string().regex(/^\d{4,12}$/)],
      ),
      (rawId, rawCode) => weixin.verify(idSchema.parse(rawId), z.string().parse(rawCode)),
    );
    register(
      'cancelBotLogin',
      operation('会话机器人', 'change', '取消机器人待完成的扫码授权', [idSchema]),
      (raw) => {
        const id = idSchema.parse(raw);
        feishu.cancel(id);
        wecom.cancel(id);
        weixin.cancel(id);
        dingtalk.cancel(id);
      },
    );
  },
};
