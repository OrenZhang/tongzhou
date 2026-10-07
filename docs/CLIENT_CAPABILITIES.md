# 客户端能力注册

功能在业务入口注册一次，桌面 IPC 和会话共用处理器。客户端管理没有第二份方法白名单，也不需要每个模块再实现一套工具协议。现有业务注册全部出现在目录中，包括需用户本人完成的操作。

## 新增功能

业务注册放在所属 `electron/modules/<功能>/*-services.ts` 或 `electron/services/<服务>/*-services.ts`，从 `core/tools/client-commands` 导入注册契约；入口负责装配。

在模块初始化时使用主进程提供的注册函数，声明模块、用途、访问方式、位置参数 Schema 和业务处理器：

```ts
register(
  'listBookmarks',
  operation('书签', 'query', '查询保存的书签', [
    z.string().optional().describe('关键词，留空查询全部'),
  ]),
  (keyword) => bookmarks.list(keyword),
);
```

不需要修改 ClientCommands、client_catalog、client_query、client_change 或原生引擎桥接。已经创建的会话工具通过实时注册表发现新操作；发布新版应用仍须加载新版模块。若新增页面按钮，仍按正常 UI 开发流程在受控 preload API 暴露所需业务方法。

- query：只查询，无修改审批；只读会话可用。
- change：修改配置或产生外部作用，使用当前会话权限和审批。参数在调用前经注册的 Zod Schema 校验；优先复用业务模块导出的 Schema。
- manual：凭据输入、权限提升、审批等必须由本人完成的操作。使用 manual(module, description, view, reason, schemas) 声明；工具目录提供原因和真实页面入口，不能通过 change 绕过。

当前路由：providers 为模型与订阅；connections 为设置下的独立连接中心；extensions 为插件；workspace、agents、activity、settings 保留各自含义。新增模块名可自由使用，不需要扩充模块枚举。

不得将口令、令牌、Cookie 放进聊天参数。模型只取得能力与认证状态，实际凭据由业务处理器从主进程加密存储取用。设备码和认证 URL 不返回给客户端管理工具；浏览器只返回窗口和登录态是否存在，不导出 Cookie。Cookie 存在不代表登录有效。

## 发现和执行

1. client_catalog({}) 返回模块、方法说明和访问状态，不展开全部参数，避免占用过多上下文。
2. client_catalog({module: '书签'}) 筛选模块；client_catalog({method: 'listBookmarks'}) 返回参数 JSON Schema。arguments 是按顺序排列的数组，prefixItems 描述各位置。
3. client_query({method: 'listBookmarks', args: []}) 执行查询。写操作使用 client_change。
4. clientMethods 是供界面使用的完整目录。错误的方法名或模块名会明确报错并返回真实注册能力，避免模型将空列表误判为整个客户端不可操作。

原生引擎可能把不定类型数组限制为字符串数组。此时优先使用 `argsJson`，将整个位置参数数组编码成 JSON 字符串，例如 `client_change({method: 'saveConnector', argsJson: JSON.stringify([{id: 'local-test', name: '本地测试', kind: 'browser', enabled: true, baseUrl: 'http://127.0.0.1:3000'}])})`。`args` 与 `argsJson` 必须且只能提供一种；解码后继续执行相同的凭据检查、参数验证与权限检查。

管理开关在调用前及批准后重新检查。注册名重复时拒绝启动该注册，避免覆盖其他模块。只读会话没有 client_change；manual 操作即使在完全开放模式也不会变成可调用操作。当前轮次不能通过管理工具递归启动、取消或删除自身，应使用会话控件。

## 验证

单元测试验证新增模块在工具附加之后注册仍可发现和执行，参数错误不进入业务处理器、拒绝/撤权生效、手动功能不可绕过。桥接测试通过真实 stdio MCP 发现并调用新增模块，内置 Codex 接受动态工具 Schema。

test:management 用独立数据库和本地合成模型，检查目录与全部业务注册一致，经真实会话工具修改外观、创建/改名会话、查询确认及刷新保留。功能目录的搜索、手动入口和明暗布局同时验证。test:workbench、test:ui、test:auth、test:appearance 回归新导航和配置页面；第三方账号授权及真实模型推理需单独验收。

## 写入与删除

内容、目录和作品保存使用 `confirmation: none`；删除业务数据使用 `confirmation: always`，完全开放会话也会显示对话内确认。普通聊天可以直接保存到指定目录，创建文档时省略 ID 与 version，编辑时读取当前版本。后台记忆、整理及定时任务仍受范围限制。普通文件写入由 Codex 原生工具负责，业务保存负责数据库、来源、版本与索引，不直接操作内部数据库。
