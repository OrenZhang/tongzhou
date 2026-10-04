'use strict';
const express = require('express');
const { parsePage, reqString, optEnum, reqEnum, reqId, safeKeyword } = require('../util/validate');
const { hashPassword } = require('../util/password');
const { audit } = require('../services/audit');

module.exports = function adminRoutes(db) {
  const r = express.Router();

  // 管理员/运营账号列表（仅 admin）
  r.get('/', (req, res) => {
    const { page, pageSize, offset } = parsePage(req.query);
    const kw = safeKeyword(req.query.keyword);
    const where = kw ? "WHERE username LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'" : '';
    const args = kw ? [`%${kw}%`, `%${kw}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS c FROM admins ${where}`).get(...args).c;
    const list = db
      .prepare(`SELECT id, username, name, role, status, created_at FROM admins ${where} ORDER BY id ASC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, offset);
    res.json({ list, total, page, pageSize });
  });

  // 新建账号（仅 admin）
  r.post('/', (req, res) => {
    const username = reqString(req.body, 'username', { min: 3, max: 30, name: '用户名' });
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: '用户名只能包含字母、数字、下划线、点和横线' });
    const name = reqString(req.body, 'name', { max: 30, name: '姓名' });
    const password = reqString(req.body, 'password', { min: 8, max: 64, name: '密码' });
    const role = reqEnum(req.body, 'role', ['admin', 'operator'], '角色');
    if (db.prepare('SELECT id FROM admins WHERE username = ?').get(username)) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    const info = db
      .prepare('INSERT INTO admins (username, password_hash, name, role) VALUES (?,?,?,?)')
      .run(username, hashPassword(password), name, role);
    audit(db, req, '新增管理员', `管理员#${Number(info.lastInsertRowid)}`, `${name}（${username}，角色 ${role}）`);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  // 启用 / 停用账号（不能停用自己）
  r.patch('/:id/status', (req, res) => {
    const id = reqId(req.params.id, '账号 ID');
    const status = reqEnum(req.body, 'status', ['active', 'disabled'], '状态');
    const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (target.id === req.admin.id) return res.status(400).json({ error: '不能停用自己的账号' });
    db.prepare('UPDATE admins SET status = ? WHERE id = ?').run(status, id);
    if (status === 'disabled') db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(id);
    audit(db, req, status === 'disabled' ? '停用账号' : '启用账号', `管理员#${id}`, `${target.name}（${target.username}）`);
    res.json({ ok: true, status });
  });

  // 重置密码（仅 admin）
  r.put('/:id/password', (req, res) => {
    const id = reqId(req.params.id, '账号 ID');
    const password = reqString(req.body, 'password', { min: 8, max: 64, name: '新密码' });
    const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
    db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(id);
    audit(db, req, '重置密码', `管理员#${id}`, target.username);
    res.json({ ok: true });
  });

  // 修改角色（不能修改自己）
  r.patch('/:id/role', (req, res) => {
    const id = reqId(req.params.id, '账号 ID');
    const role = reqEnum(req.body, 'role', ['admin', 'operator'], '角色');
    const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (target.id === req.admin.id) return res.status(400).json({ error: '不能修改自己的角色' });
    db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(role, id);
    audit(db, req, '修改角色', `管理员#${id}`, `${target.username}：${target.role} → ${role}`);
    res.json({ ok: true, role });
  });

  return r;
};
