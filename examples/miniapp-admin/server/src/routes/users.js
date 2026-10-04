'use strict';
const express = require('express');
const { parsePage, reqEnum, reqId, safeKeyword } = require('../util/validate');
const { audit } = require('../services/audit');

module.exports = function userRoutes(db) {
  const r = express.Router();

  // 用户列表：关键词搜索（昵称/手机/openid）+ 状态筛选 + 分页
  r.get('/', (req, res) => {
    const { page, pageSize, offset } = parsePage(req.query);
    const status = req.query.status === 'active' || req.query.status === 'disabled' ? req.query.status : '';
    const kw = safeKeyword(req.query.keyword);
    const conds = [];
    const args = [];
    if (kw) {
      conds.push('(nickname LIKE ? ESCAPE \'\\\' OR phone LIKE ? ESCAPE \'\\\' OR openid LIKE ? ESCAPE \'\\\')');
      args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
    }
    if (status) {
      conds.push('status = ?');
      args.push(status);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get(...args).c;
    const list = db
      .prepare(`SELECT * FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, offset);
    res.json({ list, total, page, pageSize });
  });

  // 启用 / 停用用户
  r.patch('/:id/status', (req, res) => {
    const id = reqId(req.params.id, '用户 ID');
    const status = reqEnum(req.body, 'status', ['active', 'disabled'], '状态');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
    audit(db, req, status === 'disabled' ? '停用用户' : '启用用户', `用户#${id}`, `${user.nickname}：${user.status} → ${status}`);
    res.json({ ok: true, status });
  });

  return r;
};
