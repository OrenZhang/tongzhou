import type { PluginConfig, PluginInput, PluginTool } from './types';
import { codeHost } from './code-hosting';
import { figmaConnection, figmaWriteTools } from './figma';

export function isWriteTool(config: PluginConfig, tool: PluginTool) {
  return (
    tool.annotations?.readOnlyHint === false ||
    tool.annotations?.destructiveHint === true ||
    (!!figmaConnection(config) && figmaWriteTools.has(tool.name)) ||
    (codeHost(config) === 'gitlab' &&
      config.authMode !== 'oauth' &&
      tool.name === 'gitlab_api_write')
  );
}

export function isReadOnlyTool(config: PluginConfig, tool: PluginTool) {
  if (isWriteTool(config, tool)) return false;
  return (
    config.readOnlyTools.includes(tool.name) ||
    ((!!codeHost(config) || !!figmaConnection(config)) && tool.annotations?.readOnlyHint === true)
  );
}

export function readOnlyToolErrors(config: PluginConfig, catalog: PluginTool[]) {
  const tools = new Map(catalog.map((tool) => [tool.name, tool]));
  return config.readOnlyTools.flatMap((name) => {
    const tool = tools.get(name);
    return !tool
      ? [`${name}：工具目录中不存在`]
      : isWriteTool(config, tool)
        ? [`${name}：写入或破坏性工具不能标记为只读`]
        : [];
  });
}

export function validateReadOnlyTools(config: PluginConfig, catalog: PluginTool[]) {
  const errors = readOnlyToolErrors(config, catalog);
  if (errors.length) throw new Error('只读工具配置未通过校验：' + errors.slice(0, 5).join('；'));
}

/** Editing a connection must not show evidence obtained for another endpoint or credential. */
export function pluginPermissionState(edit: PluginInput, saved?: PluginConfig): PluginConfig {
  const same =
    saved &&
    !edit.secret &&
    !edit.clearSecret &&
    !edit.oauthClientSecret &&
    !edit.clearOAuthClientSecret &&
    [
      'transport',
      'url',
      'command',
      'authMode',
      'oauthClientId',
      'oauthIssuer',
      'connectorId',
      'accountProviderId',
    ].every((key) => edit[key as keyof PluginConfig] === saved[key as keyof PluginConfig]) &&
    JSON.stringify(edit.args) === JSON.stringify(saved.args);
  return {
    ...edit,
    catalog: same ? saved.catalog : undefined,
    checkedAt: same ? saved.checkedAt : undefined,
    oauthStatus: same ? saved.oauthStatus : undefined,
    oauthScopes: same ? saved.oauthScopes : undefined,
  };
}
