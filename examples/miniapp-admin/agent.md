# Miniapp Admin 项目约定（agent.md）

## 项目简介
小程序运营后台（Miniapp Admin）：Node.js + Express + SQLite（优先 Node 内置 `node:sqlite`）后端，React + TypeScript + Vite 前端，中文界面。合成演示数据，不接真实支付或第三方账号。

## 目录结构
- `server/`：Express 后端（CommonJS）。入口 `src/index.js`，应用工厂 `src/app.js`，路由 `src/routes/`，数据库 `src/db.js`，种子数据 `src/seed.js`，测试 `test/api.test.js`。
- `web/`：React + TS 前端（ESM）。页面 `src/pages/`，公共组件 `src/components/`，API 封装 `src/api.ts`，鉴权上下文 `src/auth.tsx`。
- `docs/需求清单.md`：功能需求与验收清单。
- `data/`：SQLite 数据库目录（已被 .gitignore 排除，禁止提交）。

## 技术约定
- 后端仅可用 Node 内置模块 + express；密码哈希用 `crypto.scryptSync`（格式 `scrypt:salt:hash`），禁止明文。
- 会话：DB `sessions` 表 + HttpOnly Cookie（`miniapp_admin_sid`，SameSite=Lax）；登录有内存限流（10 分钟内 8 次）。
- 所有金额以“分”（整数 cents）存储，前端展示时再换算为元。
- 参数校验集中在 `server/src/util/validate.js`，抛出 `ValidationError`（400）；统一错误格式 `{ error: string }`。
- 权限：登录 `requireAuth`；仅管理员 `requireAdmin`（运营角色 operator 不可管理管理员、不可看审计日志）。
- 订单合法状态流转：`pending→paid/cancelled`、`paid→shipped/cancelled`、`shipped→completed`，`completed/cancelled` 为终态。
- 所有写操作必须记录审计日志（`services/audit.js`）。
- 前端通过 Vite 代理 `/api` 到 `localhost:3000`；生产模式由后端静态托管 `web/dist`。

## 常用命令
- 安装：`npm run install:all`
- 后端开发：`npm run dev:server`（Node >= 22.13，使用内置 `node:sqlite`）
- 前端开发：`npm run dev:web` → http://localhost:5173
- 测试：`npm test`（node:test 集成测试，内存数据库）
- 类型检查 + 构建：`npm run build`
- 生产：`npm run build && npm start` → http://localhost:3000

## 配置
- `server/.env`（不入 Git，参考 `server/.env.example`）：PORT、DB_PATH、SESSION_SECRET、ADMIN_PASSWORD、OPERATOR_PASSWORD、SECURE_COOKIE。

## 修改约束
- 不要提交 `server/.env`、`data/`、`node_modules/`、`web/dist`。
- 修改行为后同步更新 `docs/需求清单.md` 的验收状态与 README。
- 数据库结构变更需更新 `server/src/db.js` 中的 SCHEMA 并保持可对旧库增量生效（CREATE TABLE IF NOT EXISTS / ALTER 兼容）。
