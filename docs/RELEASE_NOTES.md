# 同舟 v1.0.2

首次发布 Linux 桌面版：与 Windows / macOS 使用同一套界面、任务系统与业务能力，不为 Linux 做精简。

- Linux 桌面版首发：面向 Ubuntu 24.04 x86_64（X11 / XWayland 会话）完成验收；原生 Wayland 会话的电脑控制在后续版本支持。
- 电脑控制（X11）：窗口识别、截图、点击、拖拽、滚动与中文输入可用；目标窗口失焦时中止操作并给出提示，不产生不完整输入。
- 凭据安全存储：桌面会话变量缺失时自动回退 gnome-libsecret；显式 --password-store 参数始终优先；不支持明文降级。
- 内置网络：Linux x64 提供 mihomo 代理资产，带固定 SHA-256 校验。
- 修复中文本地化系统（zh_CN）下 git 消息解析失配导致的项目操作失败。
- 打包与发布：Linux 提供 AppImage 与 deb 两种格式；CI 增加 Linux 预合并构建验证，发布流水线新增 Linux 打包与完整性守门。

## 安装包

Windows 使用 win-x64.exe；Apple Silicon 使用 mac-arm64.dmg；Intel Mac 使用 mac-x64.dmg；macOS ZIP 用于更新通道。Linux 使用 linux-x86_64.AppImage（下载后直接运行）或 linux-amd64.deb（`sudo apt install ./Tongzhou-1.0.2-linux-amd64.deb` 安装或升级）。各平台校验文件为 SHA256SUMS-\*。

未配置发布证书时，安装包不具备发行者签名。macOS 未签名版本提供新版安装包下载；配置 Developer ID 与公证凭据后，签名版本才启用自动安装。Linux 版本暂不支持应用内自动更新，请下载新版安装包覆盖安装。
