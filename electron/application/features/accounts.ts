import { clipboard, shell } from 'electron';
import { z } from 'zod';
import { manual, operation, workspaceOperation } from '../../core/tools/client-commands';
import { writeClipboardText } from '../../services/desktop/clipboard';
import { idSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const accountsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-accounts',
  inject: ['tzIpc', 'tzStore', 'tzRuntime', 'tzAccounts', 'tzAccountBrowser'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = ctx.tzRuntime;
    const accounts = ctx.tzAccounts;
    const accountBrowser = ctx.tzAccountBrowser;
    const accountFor = (raw: unknown, id?: unknown) =>
      accounts.native(
        z.enum(['kimi', 'minimax']).parse(raw),
        id === undefined ? undefined : idSchema.parse(id),
      );
    register(
      'nativeStatus',
      operation('模型连接与认证', 'query', '查询 Kimi 或 MiniMax 账号认证状态', [
        z.enum(['kimi', 'minimax']),
        idSchema.optional().describe('providerId'),
      ]),
      (raw, id) => accountFor(raw, id).read(),
    );
    register(
      'nativeLogin',
      workspaceOperation(store, '模型连接与认证', 'change', '启动 Kimi 或 MiniMax 账号登录', [
        z.enum(['kimi', 'minimax']),
        z.enum(['cn', 'global']),
        idSchema.optional(),
      ]),
      (raw, region, id) => {
        accounts.idle(idSchema.parse(id ?? raw + '-account'));
        return accountFor(raw, id).start(z.enum(['cn', 'global']).parse(region));
      },
    );
    register(
      'nativeCancel',
      operation('模型连接与认证', 'change', '取消 Kimi 或 MiniMax 登录', [
        z.enum(['kimi', 'minimax']),
        idSchema.optional(),
      ]),
      (raw, id) => accountFor(raw, id).cancel(),
    );
    register(
      'nativeOpen',
      workspaceOperation(store, '模型连接与认证', 'change', '打开正在等待的官方授权页面', [
        z.enum(['kimi', 'minimax']),
        idSchema.optional(),
      ]),
      (raw, id) => {
        const state = accountFor(raw, id).state;
        if (state.phase !== 'waiting' || !state.url) throw new Error('授权链接已失效，请重新登录');
        return shell.openExternal(state.url);
      },
    );
    register(
      'nativeCopyCode',
      manual(
        '模型连接与认证',
        '复制当前设备授权码',
        'providers',
        '设备授权码仅显示给用户，不传入模型',
        [z.enum(['kimi', 'minimax']), idSchema.optional()],
      ),
      (raw, id) => {
        const state = accountFor(raw, id).state;
        if (state.phase !== 'waiting' || !state.userCode) throw new Error('设备码已失效');
        return writeClipboardText(clipboard, state.userCode);
      },
    );
    register(
      'nativeLogout',
      operation('模型连接与认证', 'change', '退出指定 Kimi 或 MiniMax 账号', [
        z.enum(['kimi', 'minimax']),
        idSchema.optional(),
      ]),
      async (raw, id) => {
        accounts.idle(idSchema.parse(id ?? raw + '-account'));
        await accountFor(raw, id).logout();
        runtime.changed();
      },
    );
    const codexFor = (id?: unknown) =>
      accounts.codex(id === undefined ? undefined : idSchema.parse(id));
    register(
      'codexStatus',
      operation('模型连接与认证', 'query', '查询 ChatGPT 账号认证状态', [
        idSchema.optional().describe('providerId'),
      ]),
      (id) => codexFor(id).read(),
    );
    register(
      'codexLogin',
      workspaceOperation(store, '模型连接与认证', 'change', '启动 ChatGPT 浏览器或设备登录', [
        z.enum(['browser', 'device']).optional(),
        idSchema.optional(),
      ]),
      (method, id) => {
        accounts.idle(idSchema.parse(id ?? 'openai-codex'));
        return codexFor(id).start(z.enum(['browser', 'device']).parse(method ?? 'browser'));
      },
    );
    register(
      'codexLoginRetry',
      workspaceOperation(store, '模型连接与认证', 'change', '重试 ChatGPT 登录', [
        z.enum(['browser', 'device']),
        idSchema.optional(),
      ]),
      (method, id) => {
        accounts.idle(idSchema.parse(id ?? 'openai-codex'));
        return codexFor(id).restart(z.enum(['browser', 'device']).parse(method));
      },
    );
    register(
      'codexLoginCancel',
      operation('模型连接与认证', 'change', '取消 ChatGPT 登录', [idSchema.optional()]),
      (id) => {
        accountBrowser.close(idSchema.parse(id ?? 'openai-codex'));
        return codexFor(id).cancel();
      },
    );
    register(
      'codexLoginOpen',
      workspaceOperation(store, '模型连接与认证', 'change', '打开 ChatGPT 授权页面', [
        idSchema.optional(),
      ]),
      (id) => codexFor(id).openPage(),
    );
    register(
      'codexLoginCopyCode',
      manual(
        '模型连接与认证',
        '复制 ChatGPT 设备码',
        'providers',
        '设备授权码仅显示给用户，不传入模型',
        [idSchema.optional()],
      ),
      (id) => writeClipboardText(clipboard, codexFor(id).code()),
    );
    register(
      'codexLogout',
      operation('模型连接与认证', 'change', '退出 ChatGPT 账号', [idSchema.optional()]),
      async (id) => {
        accounts.idle(idSchema.parse(id ?? 'openai-codex'));
        await codexFor(id).logout();
        accountBrowser.close(idSchema.parse(id ?? 'openai-codex'));
        runtime.changed();
      },
    );
  },
};
