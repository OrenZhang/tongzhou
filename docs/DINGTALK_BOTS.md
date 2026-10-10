# 钉钉机器人

入口：资源与工具 → 渠道 → 添加渠道 → 钉钉「连接」→ 扫码接入。使用钉钉扫码完成平台授权后，同舟保存应用凭据；在连接配置中填写允许用户、群。也可手动填写已有应用的 Client ID 和 Client Secret，应用需启用机器人和 Stream 模式。

模型、使用模式、执行权限和默认项目在右侧统一配置，所有机器人共用。默认控制工作台，也可切换为仅聊天，不再逐个勾选会话。连接没有启用开关，保存后自动连接；连接卡片显示实际状态及失败原因。不同连接分别维护允许用户和群。

## 协议与边界

采用[钉钉官方连接器](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector)的设备注册协议：`app/registration/init` → `begin` → `poll`。服务规定的 source 为 `DING_DWS_CLAW`；HTTP 使用同舟身份。此协议只用于获取应用凭据，任务继续走同舟的 Codex 执行核心，没有运行 OpenClaw。

二维码地址只允许钉钉 HTTPS 域名，凭据仅在主进程取得并加密保存。前端只得到二维码和授权状态。支持过期、重试、取消以及忽略迟到响应；平台限制或服务不可用时可使用手动配置。扫码时需要用户具备平台所要求的创建或授权权限。

## 验证

- `npx vitest run tests/integration/dingtalk-onboarding.test.ts`：协议、取消、过期、重试、地址校验和凭据错误。
- `node scripts/testing/dingtalk-onboarding-smoke.mjs`：独立配置中模拟服务，验证界面、IPC、凭据加密和取消。
- 附加 `--live` 只取得真实二维码后取消，不自动登录账号或发送消息。
