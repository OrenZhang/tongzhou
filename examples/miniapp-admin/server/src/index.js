'use strict';
const config = require('./config');
const { createApp } = require('./app');

// 部署模式（NODE_ENV=production）必须显式开启安全 Cookie（HTTPS 反向代理下）
if (config.env === 'production' && !config.secureCookie) {
  console.error('[miniapp-admin] 生产模式要求显式安全配置：请设置 SECURE_COOKIE=1（须配合 HTTPS 部署），否则拒绝启动');
  process.exit(1);
}

const app = createApp();

app.listen(config.port, config.host, () => {
  const scope = config.host === '127.0.0.1' || config.host === 'localhost' ? '仅本机' : `接口 ${config.host}（对外可访问）`;
  console.log(`[miniapp-admin] 服务已启动: http://${config.host}:${config.port}（${scope}）`);
  console.log(`[miniapp-admin] 数据库: ${config.dbPath}`);
  if (config.env === 'production') {
    console.log('[miniapp-admin] 生产模式：未设置 ADMIN_PASSWORD 时不会创建任何默认账号与演示数据');
  } else {
    console.log('[miniapp-admin] 演示账号: admin / operator（密码见 server/.env.example 或环境变量）');
  }
});
