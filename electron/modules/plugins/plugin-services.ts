import { dialog, type BrowserWindow } from 'electron';
import type { Store } from '../../services/storage/store';
import type { Runtime } from '../../core/runtime/runtime';
import {
  operation,
  workspaceOperation,
  type ClientRegistrar,
} from '../../core/tools/client-commands';
import { idSchema, pluginSchema } from '../../services/storage/validation';
import { absolutePathSchema } from '../../services/storage/file-transfer';
import type { AgentProfile, PluginConfig } from '../../../src/shared/types';
import type { Connectors } from '../../services/accounts/connectors';
import { McpAuth, pluginOAuth, pluginAuthIdentity } from './mcp-auth';
import { PluginConnection, importSkillDirectory, pluginTool } from '../../core/tools/extensions';
import { pluginSecret, pluginCredentialVersion } from './code-hosting';
import { codeHost } from '../../../src/shared/code-hosting';
import { isBuiltinSkill } from '../../../src/shared/builtin-skills';
import {
  createPersonalSkill,
  createSkillSchema,
  saveExistingSkill,
  saveSkillSchema,
} from './skills';

export function registerPluginServices(
  register: ClientRegistrar,
  store: Store,
  runtime: Runtime,
  mcpAuth: McpAuth,
  connectors: Connectors,
  getWindow: () => BrowserWindow | undefined,
) {
  register(
    'savePlugin',
    operation('插件', 'change', '保存或启停 MCP 插件配置，凭据在界面输入', [pluginSchema]),
    (raw) => {
      const { secret, clearSecret, oauthClientSecret, clearOAuthClientSecret, ...config } =
        pluginSchema.parse(raw);
      if (secret || clearSecret || config.authMode === 'oauth') config.connectorId = undefined;
      if (config.connectorId) pluginSecret(store, config);
      const previous = store.list<PluginConfig>('plugin').find((p) => p.id === config.id);
      const identityChanged =
        !!previous &&
        (pluginAuthIdentity(previous) !== pluginAuthIdentity(config) ||
          previous.command !== config.command ||
          previous.connectorId !== config.connectorId ||
          JSON.stringify(previous.args) !== JSON.stringify(config.args));
      const clientSecretChanged = !!oauthClientSecret || !!clearOAuthClientSecret;
      if (identityChanged || clearSecret || clientSecretChanged) mcpAuth.logout(config.id);
      store.saveSecret(
        'plugin_oauth_client_' + config.id,
        config.authMode === 'oauth' ? oauthClientSecret : undefined,
        identityChanged || clearOAuthClientSecret || config.authMode !== 'oauth',
      );
      const same =
        previous &&
        !identityChanged &&
        !secret &&
        !clearSecret &&
        !clientSecretChanged &&
        previous.transport === config.transport &&
        previous.command === config.command &&
        previous.url === config.url &&
        JSON.stringify(previous.args) === JSON.stringify(config.args);
      if (identityChanged) store.saveSecret('plugin_' + config.id, undefined, true);
      store.saveSecret(
        'plugin_' + config.id,
        secret,
        clearSecret || config.authMode === 'oauth' || !!config.connectorId,
      );
      store.put('plugin', {
        ...config,
        oauthStatus:
          config.authMode === 'oauth' && !identityChanged && !clearSecret && !clientSecretChanged
            ? previous?.oauthStatus
            : undefined,
        oauthError:
          !identityChanged && !clearSecret && !clientSecretChanged
            ? previous?.oauthError
            : undefined,
        ...(same ? { catalog: previous.catalog, checkedAt: previous.checkedAt } : {}),
      });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'deletePlugin',
    operation('插件', 'change', '删除 MCP 插件', [idSchema.describe('pluginId')], {
      confirmation: 'always',
    }),
    (raw) => {
      const id = idSchema.parse(raw);
      mcpAuth.logout(id);
      store.remove('plugin', id);
      store.saveSecret('plugin_' + id, undefined, true);
      store.saveSecret('plugin_oauth_client_' + id, undefined, true);
      for (const a of store.list<AgentProfile>('agent'))
        store.put('agent', { ...a, pluginIds: a.pluginIds?.filter((p) => p !== id) });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'testPlugin',
    operation('插件', 'change', '连接插件并发现其工具', [idSchema.describe('pluginId')]),
    async (raw) => {
      const p = store.get<PluginConfig>('plugin', idSchema.parse(raw));
      const credentials = pluginCredentialVersion(store, p);
      const c = new PluginConnection(p, pluginSecret(store, p), pluginOAuth(store, p));
      try {
        const signal = AbortSignal.timeout(30000);
        await c.connect(signal);
        const catalog = (await c.tools(signal)).map(pluginTool);
        const current = store.get<PluginConfig>('plugin', p.id);
        if (
          JSON.stringify(current) !== JSON.stringify(p) ||
          pluginCredentialVersion(store, p) !== credentials
        )
          throw new Error('插件配置已变更，请重新检查');
        store.put('plugin', { ...p, catalog, checkedAt: Date.now() });
        runtime.changed();
        return catalog;
      } finally {
        await c.close();
      }
    },
  );
  register(
    'loginPlugin',
    workspaceOperation(store, '插件', 'change', '开始插件 OAuth 浏览器认证', [
      idSchema.describe('pluginId'),
    ]),
    (raw) => {
      return mcpAuth.login(idSchema.parse(raw));
    },
  );
  register(
    'cancelPluginLogin',
    operation('插件', 'change', '取消插件待完成的授权', [idSchema.describe('pluginId')]),
    (raw) => mcpAuth.cancel(idSchema.parse(raw)),
  );
  register(
    'logoutPlugin',
    operation('插件', 'change', '退出插件账号授权', [idSchema.describe('pluginId')]),
    (raw) => {
      mcpAuth.logout(idSchema.parse(raw));
      runtime.invalidateNative();
    },
  );
  register(
    'useGithubConnector',
    operation('插件', 'change', '将已有 GitHub 账号用于官方 GitHub MCP', [
      idSchema.describe('pluginId'),
      idSchema.describe('connectorId'),
    ]),
    (rawPlugin, rawConnector) => {
      const p = store.get<PluginConfig>('plugin', idSchema.parse(rawPlugin));
      const c = connectors.list().find((c) => c.id === idSchema.parse(rawConnector));
      if (
        codeHost(p) !== 'github' ||
        p.transport !== 'http' ||
        p.authMode === 'oauth' ||
        c?.kind !== 'github' ||
        new URL(c.baseUrl).origin !== 'https://github.com' ||
        !c.enabled
      )
        throw new Error('仅可将启用的 GitHub 官方站点账号连接到官方 GitHub MCP');
      const token = store.secret('connector_' + c.id);
      if (!token) throw new Error('此 GitHub 账号尚未保存访问令牌');
      // Resolve the current account token at execution time, including future refreshes/logout.
      store.saveSecret('plugin_' + p.id, undefined, true);
      store.put('plugin', { ...p, connectorId: c.id, catalog: undefined, checkedAt: undefined });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'importSkill',
    workspaceOperation(store, 'Skills', 'change', '从目录导入 SKILL.md 技能', [
      absolutePathSchema.optional(),
    ]),
    async (directory) => {
      const chosen = directory
        ? { canceled: false, filePaths: [absolutePathSchema.parse(directory)] }
        : await dialog.showOpenDialog(getWindow()!, {
            title: '选择包含 SKILL.md 的目录',
            properties: ['openDirectory'],
          });
      if (chosen.canceled) return null;
      const skill = await importSkillDirectory(chosen.filePaths[0]);
      store.put('skill', skill);
      runtime.changed();
      return skill;
    },
  );
  register(
    'createSkill',
    operation(
      'Skills',
      'change',
      '创建个人技能：传入完整 SKILL.md 和可选附属文本文件，保存后显示在个人插件，默认启用',
      [createSkillSchema],
    ),
    (raw) => {
      const skill = createPersonalSkill(store, raw);
      runtime.invalidateNative();
      runtime.changed();
      return skill;
    },
  );
  register(
    'saveSkill',
    operation(
      'Skills',
      'change',
      '修改或启停已有技能；内置技能只允许启停，个人技能可更新内容和附属文件',
      [saveSkillSchema],
    ),
    (raw) => {
      saveExistingSkill(store, raw);
      runtime.invalidateNative();
      runtime.changed();
    },
  );
  register(
    'deleteSkill',
    operation('Skills', 'change', '删除已导入技能', [idSchema.describe('skillId')], {
      confirmation: 'always',
    }),
    (raw) => {
      const id = idSchema.parse(raw);
      if (isBuiltinSkill(id)) throw new Error('内置技能不可删除，可以停用');
      store.remove('skill', id);
      for (const a of store.list<AgentProfile>('agent'))
        store.put('agent', { ...a, skillIds: a.skillIds?.filter((s) => s !== id) });
      runtime.invalidateNative();
      runtime.changed();
    },
  );
}
