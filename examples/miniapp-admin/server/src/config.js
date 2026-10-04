'use strict';
const fs = require('fs');
const path = require('path');

// 轻量 .env 加载（不覆盖已存在的环境变量）
function loadEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v && !(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch {
    /* .env 不存在时使用默认值 */
  }
}

loadEnv(path.join(__dirname, '..', '.env'));

function resolveDbPath(p) {
  if (p === ':memory:') return p;
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', p);
}

const env = process.env.NODE_ENV || 'development';

module.exports = {
  env,
  // 默认仅监听本机回环地址；对外部署需显式设置 HOST=0.0.0.0
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  dbPath: resolveDbPath(process.env.DB_PATH || './data/app.db'),
  sessionHours: Math.min(72, Math.max(1, Number(process.env.SESSION_HOURS || 12))),
  // 生产模式不提供默认密码：必须显式设置 ADMIN_PASSWORD/OPERATOR_PASSWORD
  adminPassword: process.env.ADMIN_PASSWORD || (env === 'production' ? null : 'Admin@123456'),
  operatorPassword: process.env.OPERATOR_PASSWORD || (env === 'production' ? null : 'Operator@123456'),
  secureCookie: process.env.SECURE_COOKIE === '1',
  webDist: process.env.WEB_DIST || path.join(__dirname, '..', '..', 'web', 'dist'),
};
