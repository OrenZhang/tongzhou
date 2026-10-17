import { useState } from 'react';
import type { PluginConfig } from '../../shared/types';
import { isReadOnlyTool, isWriteTool, readOnlyToolErrors } from '../../shared/plugin-permissions';
import { figmaConnection, figmaAccessMessage, figmaToolsUrl } from '../../shared/figma';
import { MarkdownLink } from '../../components/markdown/RichMarkdown';

export function FigmaConnectionInfo({ plugin }: { plugin: PluginConfig }) {
  const desktop = figmaConnection(plugin) === 'desktop';
  return (
    <div className="mcp-connection-info">
      {desktop ? (
        <p>
          在 Figma 桌面应用打开文件，进入 Dev Mode 并启用 MCP Server，再点击「保存并检查」。
          无需在同舟登录；桌面服务不提供 FigJam 图表生成。
        </p>
      ) : (
        <>
          <p>
            <span className="status-pill">远程接入待批准</span> 申请范围：全部读写工具
          </p>
          <p>{figmaAccessMessage}</p>
          <small>
            浏览器授权由同舟管理，无需填写 Client ID 或 Secret。登录会重新检查能否接入。
          </small>
        </>
      )}
      <MarkdownLink href={figmaToolsUrl}>查看 Figma 工具与权限说明</MarkdownLink>
    </div>
  );
}

export function McpPermissions({ plugin }: { plugin: PluginConfig }) {
  const catalog = plugin.catalog ?? [];
  const checked = !!plugin.checkedAt && !!plugin.catalog;
  const read = catalog.filter((tool) => isReadOnlyTool(plugin, tool)).length;
  const write = catalog.filter((tool) => isWriteTool(plugin, tool)).length;
  const errors = checked ? readOnlyToolErrors(plugin, catalog) : [];
  const figma = figmaConnection(plugin);
  return (
    <div className="mcp-permissions" aria-label="MCP 权限说明与校验">
      <dl className="mcp-permission-status">
        <div>
          <dt>连接检查</dt>
          <dd>{checked ? `目录已验证 · ${catalog.length} 个工具` : '尚未通过连接检查'}</dd>
        </div>
        {plugin.authMode === 'oauth' && (
          <div>
            <dt>账号授权范围</dt>
            <dd>
              {plugin.oauthStatus !== 'authorized'
                ? '尚未完成授权'
                : plugin.oauthScopes?.length
                  ? plugin.oauthScopes.join(' · ')
                  : '服务端未返回范围，无法确认全部读写权限'}
            </dd>
          </div>
        )}
        {checked && (
          <div>
            <dt>工具分类</dt>
            <dd>
              {read} 个只读 · {write} 个写入 · {catalog.length - read - write}{' '}
              个未确认（按写操作处理）
            </dd>
          </div>
        )}
        {figma && (
          <div>
            <dt>FigJam 图表生成</dt>
            <dd>
              {figma === 'desktop'
                ? '桌面服务不提供，需要远程 MCP'
                : !checked
                  ? '待连接检查'
                  : catalog.some((tool) => tool.name === 'generate_diagram')
                    ? '目录中已提供，需要写权限'
                    : '当前工具目录未提供'}
            </dd>
          </div>
        )}
      </dl>
      {errors.length > 0 && <p role="alert">{errors.slice(0, 5).join('；')}</p>}
      <p className="mcp-permission-note">
        连接检查只验证认证、工具目录和只读配置，不执行写操作。目录中有工具不代表对所有文件或项目有权限，实际调用仍由服务端检查账号、资源权限与额度。
      </p>
      <details>
        <summary>会话权限如何生效</summary>
        <p>
          只读：仅提供已确认的只读工具。按需审批：调用工具前按会话规则询问。完全开放：自动批准已启用工具，仍受服务端授权限制。
        </p>
        <p>
          自定义 MCP 的工具声明仅供参考，不会自动授予只读权限；只能显式添加已确认的只读工具。官方
          GitHub、GitLab 与 Figma 服务可识别只读声明。写入或破坏性工具不能覆盖为只读。
        </p>
      </details>
    </div>
  );
}

export function PluginToolList({ plugin }: { plugin: PluginConfig }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const tools = (plugin.catalog ?? []).filter((tool) =>
    (tool.name + ' ' + tool.description).toLowerCase().includes(query.toLowerCase()),
  );
  const last = Math.max(0, Math.ceil(tools.length / 20) - 1);
  const current = Math.min(page, last);
  return (
    <details>
      <summary>{plugin.catalog?.length ?? 0} 个已发现工具 · Agent 按需搜索调用</summary>
      <input
        aria-label={`${plugin.name} 工具搜索`}
        placeholder="搜索工具名称或用途"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(0);
        }}
      />
      <div className="plugin-tool-list">
        {tools.slice(current * 20, (current + 1) * 20).map((tool) => (
          <p key={tool.name}>
            <strong>{tool.name}</strong>
            <small className="mcp-tool-access">
              {isReadOnlyTool(plugin, tool)
                ? plugin.readOnlyTools.includes(tool.name)
                  ? '只读 · 本机设置'
                  : '只读 · 官方声明'
                : isWriteTool(plugin, tool)
                  ? '写入 / 破坏性'
                  : '未确认 · 按写操作处理'}
            </small>
            <span>{tool.description.slice(0, 180)}</span>
          </p>
        ))}
        {!tools.length && <p>没有匹配的工具</p>}
      </div>
      {tools.length > 20 && (
        <div className="row">
          <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
            上一页
          </button>
          <span>
            {current + 1} / {last + 1}
          </span>
          <button type="button" disabled={current === last} onClick={() => setPage(current + 1)}>
            下一页
          </button>
        </div>
      )}
    </details>
  );
}
