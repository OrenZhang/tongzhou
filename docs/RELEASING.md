# 版本发布与更新

源码在 `main` 开发；`release` 是稳定版发布分支。安装包上传到 GitHub Releases，不提交进 Git。现阶段无需额外后台服务：Actions 构建，Releases 分发，GitHub Issues 记录问题。

## 发布

1. 更新 `package.json`、锁文件和 `docs/RELEASE_NOTES.md`。稳定版使用新的三段版本号。
2. 验证后将指定提交快进到 `release`，或在该分支手动运行 Publish release。
3. Windows x64、macOS Intel、macOS Apple Silicon 分别在原生机器运行测试、打包和安装包启动验证。
4. 全部成功后，流程核对版本与 SHA-512，合并双架构 macOS 更新清单，创建 `v版本号` 标签及正式 Release。已发布版本禁止覆盖，修复需升版。

发布内容包括 EXE、DMG、ZIP、blockmap、latest.yml、latest-mac.yml、SHA256SUMS。源码开发预览不执行自动更新；正式包启动后及每六小时检查一次，发现版本才显示侧栏更新图标。下载由用户点击发起，校验后安装并重启。存在运行会话、终端或排队任务时拒绝安装；下载期间新任务启动时保留已下载包，等待用户再次点击。

## 签名

Windows 可配置 `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。macOS 配置 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD` 及公证用的 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

证书和凭据仅放在 GitHub Actions Secrets。未配置时可以生成未签名安装包，但 macOS 不启用自动安装，仅提供正式发布页下载；签名与公证齐备后才在包中启用自动更新。不能用关闭系统安全检查来代替签名。

## 运维

构建失败在 Actions 中查对应平台日志。测试与打包失败均阻止 Release 公开，诊断产物保存七天。更新源固定为 `OrenZhang/tongzhou` 的正式 Releases，排除预发布与降级，不向客户端分发 GitHub 凭据。

GitHub Projects 是问题看板，不是安装包托管服务；将待办 Issues 加入 TongZhou 看板跟踪即可。首次正式发布前的旧预览需手动安装一次，后续使用内置更新。
