# GitHub 维护与发布

仓库包含主分支/PR 检查和标签草稿发布流程。源码使用 Apache-2.0；模型账号、个人数据库、安装包和依赖目录不进入 Git 历史。

## 仓库与本地推送

仓库地址为 `https://github.com/OrenZhang/tongzhou`，默认分支为 `main`。已有工作目录应先检查 `git remote -v`，新环境可直接 clone。Codex 的 GitHub 连接不等于电脑上的 Git 命令已登录；使用命令行推送时，需要维护者自行完成 GitHub CLI 或 Git Credential Manager 登录。

```bash
gh auth login
gh auth setup-git
git push -u origin main
```

首次通过 GitHub 连接器导入时，提交说明保留来源本地提交 ID；GitHub 会为导入记录生成新的提交 ID。后续从远端历史继续维护。不要覆盖已有仓库历史或强制推送。

## 后续版本

1. 修改版本与发行说明，运行 `npm test`、`npm run build` 和 `npm run test:desktop`。
2. 在 Windows 和 macOS 检查安装、启动、真实账号登录、工具执行、退出恢复。
3. 提交代码并创建对应 `v*` 标签，推送到 GitHub。
4. 标签工作流构建两端安装包并创建草稿 Release。检查构建日志、校验值及平台测试后，再公开草稿。

公开分发前应为 Windows 配置代码签名，为 macOS 配置 Developer ID 签名、公证。私钥、证书和令牌仅保存在受限的 GitHub Actions Secrets 中，不写入仓库。默认工作流不提供自动更新渠道。
