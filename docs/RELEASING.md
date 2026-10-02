# GitHub 维护与发布

仓库包含主分支/PR 检查和标签草稿发布流程。源码使用 Apache-2.0；模型账号、个人数据库、安装包和依赖目录不进入 Git 历史。

## 首次发布

以下步骤需要维护者自己的 GitHub 登录与创建仓库权限。命令是发布说明，首版交付时尚未在远端执行。

```bash
gh auth login
gh repo create tongzhou --public --source . --remote origin --push
git push origin v0.1.0
```

如果仓库已经存在，应核实其用途和内容，再设置正确的 origin 并正常推送。不要覆盖已有仓库历史或强制推送。

## 后续版本

1. 修改版本与发行说明，运行 `npm test`、`npm run build` 和 `npm run test:desktop`。
2. 在 Windows 和 macOS 检查安装、启动、真实账号登录、工具执行、退出恢复。
3. 提交代码并创建对应 `v*` 标签，推送到 GitHub。
4. 标签工作流构建两端安装包并创建草稿 Release。检查构建日志、校验值及平台测试后，再公开草稿。

公开分发前应为 Windows 配置代码签名，为 macOS 配置 Developer ID 签名、公证。私钥、证书和令牌仅保存在受限的 GitHub Actions Secrets 中，不写入仓库。默认工作流不提供自动更新渠道。
