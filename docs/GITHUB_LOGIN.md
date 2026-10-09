# GitHub 登录

普通用户在 **插件 → GitHub 仓库工具** 选择 **OAuth2 授权**，点击 **使用 GitHub 登录**。同舟打开 GitHub 官方设备授权页，界面显示一次性验证码；在 GitHub 完成登录和授权后，同舟校验账号身份及官方 MCP 工具连接，再加密保存授权并显示账号。界面不提供自定义 Client ID、Client Secret 或 Issuer。

登录支持取消、超时、拒绝和网络失败；不把尚未校验的授权显示为成功。重启保留已验证的授权；令牌过期时使用刷新令牌更新并重新校验身份，无刷新令牌或刷新失效时要求重新登录。退出授权删除本机保存的令牌，停止使用旧授权；若需撤销 GitHub 服务端授权，可在 GitHub 的 Authorized OAuth Apps 中撤销同舟。

## 维护者的一次性准备

1. 在 GitHub Developer Settings 注册同舟自己的 OAuth App，应用名称为 **同舟 Tongzhou**，主页为项目仓库。
2. 注册页选择 **Enable Device Flow** 和 **Expire user access tokens**。回调可填写 `http://127.0.0.1:17438/mcp/callback`，关闭 wildcard matching；设备授权流程本身不使用回调端口。
3. 将公开 Client ID 设置为仓库 Actions 变量 `TONGZHOU_GITHUB_CLIENT_ID`。Release 工作流将它编译进主进程；本地构建可运行 `TONGZHOU_GITHUB_CLIENT_ID=<公开ID> npm run build`。开发或隔离测试可用同名环境变量覆盖。无需生成或分发 Client Secret。
4. 应用注册不会给同舟访问任何用户仓库；每位用户须自行在 GitHub 确认授权，实际访问仍由令牌范围、仓库权限和组织策略控制。

尚未配置应用身份的构建会明确显示 GitHub 登录尚不可用，可选择手动 Token 或保留的本地账号发现。不要使用其他产品的 Client ID。

依据：[GitHub 官方 OAuth 设备授权与刷新](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)；[GitHub 官方 MCP 接入](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)。设备授权请求 `repo read:user`，向官方 MCP 传入 OAuth access token；Token 配置模式独立保留。
