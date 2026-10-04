# 小程序运营后台（Miniapp Admin）

小程序运营后台 MVP：管理员登录、仪表盘统计、用户/分类/商品/订单/公告管理、双角色权限、操作审计。
全合成演示数据，不接真实支付或第三方账号。

- 后端：Node.js（>= 22.13）+ Express + Node 内置 `node:sqlite`（CommonJS）
- 前端：React 18 + TypeScript + Vite（ESM，Vite 开发时代理 `/api` 到 3000 端口）
- 界面语言：中文

## 目录结构

```
├── docs/需求清单.md      功能需求与验收状态
├── server/               Express 后端
│   ├── src/index.js      启动入口（监听地址/生产安全检查）
│   ├── src/app.js        应用工厂（路由挂载、静态托管、错误处理）
│   ├── src/config.js     配置（.env 加载）
│   ├── src/db.js         SQLite 连接与 SCHEMA
│   ├── src/seed.js       种子数据（生产模式不生成演示数据）
│   ├── src/routes/       auth/users/categories/products/orders/announcements/admins/audit
│   ├── src/middleware/   会话鉴权、统一错误
│   ├── src/services/audit.js  审计写入
│   ├── src/util/         校验、密码哈希、cookie 解析
│   └── test/api.test.js  API 集成测试（node:test，内存数据库）
├── web/                  React + TS 前端（src/pages 八个页面）
└── package.json          根编排脚本
```

## 快速开始

要求 Node.js >= 22.13（使用内置 `node:sqlite`）。

```bash
npm run install:all     # 安装 server 与 web 依赖
npm run dev:server      # 后端 http://127.0.0.1:3000（默认仅本机）
npm run dev:web         # 前端 http://localhost:5173（/api 代理到 3000）
```

生产模式（后端托管前端构建产物）：

```bash
npm run build           # tsc 类型检查 + vite 构建 → web/dist
npm start               # http://127.0.0.1:3000
```

测试与检查：

```bash
npm test                # 后端 18 个 API 集成测试（node:test，内存库）
npm run typecheck       # 前端 tsc --noEmit
npm run build           # 类型检查 + 前端构建
```

## 演示账号（仅开发/测试环境自动创建）

| 账号 | 密码 | 角色 |
|---|---|---|
| admin | Admin@123456 | 管理员（全部权限） |
| operator | Operator@123456 | 运营（不可管理管理员、不可看审计日志） |

## 配置（server/.env，参考 server/.env.example）

| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 3000 | 服务端口 |
| HOST | 127.0.0.1 | 监听地址。默认仅本机；对外部署显式设 0.0.0.0 并配合 HTTPS 反向代理 |
| DB_PATH | ./data/app.db | SQLite 文件路径（相对 server 目录） |
| ADMIN_PASSWORD / OPERATOR_PASSWORD | 开发环境内置演示密码 | 生产模式必须显式设置，否则不创建任何账号 |
| SESSION_HOURS | 12 | 会话有效期（小时，1–72） |
| SECURE_COOKIE | 0 | 置 1 后 Cookie 带 Secure。生产模式必须为 1，否则拒绝启动 |

注：会话令牌本身为 64 位随机十六进制串（DB `sessions` 表），无额外签名密钥，早期预留的
SESSION_SECRET 已移除。

## 生产部署安全要求

1. `NODE_ENV=production` 且 `SECURE_COOKIE=1`（须配合 HTTPS 反向代理），否则进程启动即退出（exit 1）。
2. 显式设置 `ADMIN_PASSWORD`（可选 `OPERATOR_PASSWORD`）。生产模式下数据库为空时：
   - 未设密码：不创建任何账号与演示数据（登录一律 401），防止默认密码账号；
   - 已设密码：仅创建 admin/operator 账号，不生成合成用户/商品/订单数据。
3. 默认仅监听 127.0.0.1；对外服务显式设置 `HOST=0.0.0.0` 并置于 HTTPS 反向代理之后。

## 功能与规则

- 登录：scrypt 密码哈希（`scrypt:salt:hash`）；DB 会话 + HttpOnly + SameSite=Lax Cookie；
  登录限流（同 IP+用户名 10 分钟内 8 次失败，成功即清零）；停用账号即刻失效。
- 订单合法流转：`pending→paid/cancelled`、`paid→shipped/cancelled`、`shipped→completed`，
  `completed/cancelled` 终态不可再流转，非法流转一律 400。
- 金额一律以“分”（整数）存储，前端展示时换算为元。
- 商品校验：拒绝负价格与负库存（新增与编辑均拒绝；0 元 / 0 库存合法）；分类存在；名称非空。
- 角色：admin 全权限；operator 业务接口可用，访问 `/api/admins`、`/api/audit-logs` 返回 403。
- 审计：登录、启停、CRUD、订单流转、改密等写操作全部留痕（操作人、动作、对象、详情、IP、时间）。
- 列表：用户/商品/订单/公告/管理员/审计均支持分页与关键词搜索；搜索无结果时返回
  `total=0` 与空数组，前端展示空状态文案。

## API 一览（均需登录，除登录接口）

| 方法与路径 | 说明 | 角色 |
|---|---|---|
| POST /api/auth/login · POST /api/auth/logout · GET /api/auth/me | 登录/退出/当前用户 | - |
| GET /api/dashboard | 统计、最近订单、近 7 天趋势 | 登录 |
| GET /api/users · PATCH /api/users/:id/status | 用户分页搜索 · 启停 | 登录 |
| GET/POST /api/categories · PUT/DELETE /api/categories/:id · PATCH status | 分类管理 | 登录 |
| GET/POST /api/products · PUT /api/products/:id · PATCH status | 商品管理 | 登录 |
| GET /api/orders · GET /api/orders/:id · PATCH /api/orders/:id/status | 订单与状态流转 | 登录 |
| GET/POST /api/announcements · PUT/DELETE /api/announcements/:id · PATCH status | 公告（草稿/发布） | 登录 |
| GET/POST /api/admins · PATCH /api/admins/:id/status · PATCH role · PUT password | 账号管理 | 仅 admin |
| GET /api/audit-logs | 审计查询 | 仅 admin |

错误统一为 `{ "error": string }`；参数校验失败 400，未登录 401，越权 403，不存在 404，冲突 409。

## 验证记录（2026-10-04）

- `npm test`：18/18 通过（认证会话、限流 429、越权 403、CRUD、分页与搜索、空状态、
  负价格/负库存 400、订单合法/非法流转、公告草稿/发布、审计留痕、仪表盘）。
- `npm run build`：tsc 无错误，vite 构建成功。
- 端到端 curl 验证：登录 Set-Cookie 含 HttpOnly/SameSite=Lax；带 Cookie 访问受保护接口 200；
  未带 Cookie 401；退出后会话失效；后端静态托管前端构建产物。
- 生产安全检查：未设 SECURE_COOKIE 启动即退出（exit 1）；生产模式未设密码时 seeded=false
  且默认密码登录 401。
