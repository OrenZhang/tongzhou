'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { verifyPassword } = require('../util/password');
const { reqString } = require('../util/validate');
const { parseCookies } = require('../util/http');
const { audit } = require('../services/audit');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');

// 登录限流：同一 IP+用户名 10 分钟内最多 8 次尝试（内存实现，单机部署够用）
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

// 只统计失败尝试，登录成功即清零
function failedAttempts(key) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || a.resetAt < now) {
    a = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(key, a);
  }
  if (attempts.size > 10000) attempts.clear();
  return a;
}

function loginLimited(req, res, key) {
  const a = failedAttempts(key);
  if (a.count >= MAX_ATTEMPTS) {
    res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' });
    return true;
  }
  return false;
}

function publicAdmin(a) {
  return { id: a.id, username: a.username, name: a.name, role: a.role, status: a.status };
}

function sessionCookie(token, maxAgeMs) {
  const secure = config.secureCookie ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

module.exports = function authRoutes(db) {
  const r = express.Router();

  r.post('/login', (req, res) => {
    const username = reqString(req.body, 'username', { max: 50, name: '用户名' });
    const password = reqString(req.body, 'password', { min: 1, max: 100, name: '密码' });
    const limitKey = `${req.ip}|${username}`;
    if (loginLimited(req, res, limitKey)) return;
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      failedAttempts(limitKey).count += 1;
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (admin.status !== 'active') {
      return res.status(403).json({ error: '账号已被停用，请联系管理员' });
    }
    attempts.delete(limitKey);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    const maxAge = config.sessionHours * 3600 * 1000;
    db.prepare('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?,?,?)').run(token, admin.id, Date.now() + maxAge);
    res.setHeader('Set-Cookie', sessionCookie(token, maxAge));
    req.admin = { id: admin.id, username: admin.username, name: admin.name, role: admin.role };
    audit(db, req, '登录', `管理员#${admin.id}`, `${admin.name} 登录成功`);
    res.json({ user: publicAdmin(admin) });
  });

  r.post('/logout', (req, res) => {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    if (req.admin) audit(db, req, '退出登录', `管理员#${req.admin.id}`, req.admin.name);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.admin });
  });

  return r;
};
