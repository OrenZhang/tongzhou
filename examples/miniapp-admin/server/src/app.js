'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const { getDb } = require('./db');
const { seed } = require('./seed');
const { attachAdmin, requireAuth, requireAdmin } = require('./middleware/auth');
const { errorHandler, notFoundApi } = require('./middleware/error');

function createApp() {
  const db = getDb();
  const seeded = seed(db);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  // 基础安全响应头
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use(attachAdmin(db));

  app.get('/api/health', (req, res) => res.json({ ok: true, seeded }));

  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api/dashboard', requireAuth, require('./routes/dashboard')(db));
  app.use('/api/users', requireAuth, require('./routes/users')(db));
  app.use('/api/categories', requireAuth, require('./routes/categories')(db));
  app.use('/api/products', requireAuth, require('./routes/products')(db));
  app.use('/api/orders', requireAuth, require('./routes/orders')(db));
  app.use('/api/announcements', requireAuth, require('./routes/announcements')(db));
  app.use('/api/admins', requireAuth, requireAdmin, require('./routes/admins')(db));
  app.use('/api/audit-logs', requireAuth, requireAdmin, require('./routes/audit')(db));

  app.use('/api', notFoundApi);

  // 生产模式：托管前端构建产物（SPA 回退）
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
