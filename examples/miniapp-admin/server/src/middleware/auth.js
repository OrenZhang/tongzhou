'use strict';
const { parseCookies } = require('../util/http');

const COOKIE_NAME = 'miniapp_admin_sid';

function attachAdmin(db) {
  return (req, res, next) => {
    req.admin = null;
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return next();
    const row = db
      .prepare(
        `SELECT s.expires_at, a.id, a.username, a.name, a.role, a.status
         FROM sessions s JOIN admins a ON a.id = s.admin_id
         WHERE s.token = ?`
      )
      .get(token);
    if (!row) return next();
    if (row.expires_at < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return next();
    }
    if (row.status !== 'active') return next();
    req.admin = { id: row.id, username: row.username, name: row.name, role: row.role };
    req.sessionToken = token;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: '未登录或会话已过期' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: '未登录或会话已过期' });
  if (req.admin.role !== 'admin') return res.status(403).json({ error: '无权限执行此操作（需要管理员角色）' });
  next();
}

module.exports = { attachAdmin, requireAuth, requireAdmin, COOKIE_NAME };
