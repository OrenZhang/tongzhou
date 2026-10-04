'use strict';
const express = require('express');
const { parsePage, reqString, optEnum, reqEnum, reqId, safeKeyword } = require('../util/validate');
const { audit } = require('../services/audit');

module.exports = function announcementRoutes(db) {
  const r = express.Router();

  // 公告列表：关键词 + 状态筛选 + 分页
  r.get('/', (req, res) => {
    const { page, pageSize, offset } = parsePage(req.query);
    const status = req.query.status === 'draft' || req.query.status === 'published' ? req.query.status : '';
    const kw = safeKeyword(req.query.keyword);
    const conds = [];
    const args = [];
    if (status) {
      conds.push('status = ?');
      args.push(status);
    }
    if (kw) {
      conds.push('(title LIKE ? ESCAPE \'\\\' OR content LIKE ? ESCAPE \'\\\')');
      args.push(`%${kw}%`, `%${kw}%`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM announcements ${where}`).get(...args).c;
    const list = db
      .prepare(`SELECT * FROM announcements ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, offset);
    res.json({ list, total, page, pageSize });
  });

  r.post('/', (req, res) => {
    const title = reqString(req.body, 'title', { max: 80, name: '标题' });
    const content = reqString(req.body, 'content', { min: 1, max: 5000, name: '内容' });
    const status = optEnum(req.body, 'status', ['draft', 'published'], '状态', 'draft');
    const publishedAt = status === 'published' ? new Date().toISOString() : null;
    const info = db
      .prepare('INSERT INTO announcements (title, content, status, published_at) VALUES (?,?,?,?)')
      .run(title, content, status, publishedAt);
    audit(db, req, '新增公告', `公告#${Number(info.lastInsertRowid)}`, title);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.put('/:id', (req, res) => {
    const id = reqId(req.params.id, '公告 ID');
    const old = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
    if (!old) return res.status(404).json({ error: '公告不存在' });
    const title = reqString(req.body, 'title', { max: 80, name: '标题' });
    const content = reqString(req.body, 'content', { min: 1, max: 5000, name: '内容' });
    db.prepare("UPDATE announcements SET title = ?, content = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(title, content, id);
    audit(db, req, '编辑公告', `公告#${id}`, title);
    res.json({ ok: true });
  });

  // 发布 / 撤回（草稿）
  r.patch('/:id/status', (req, res) => {
    const id = reqId(req.params.id, '公告 ID');
    const status = reqEnum(req.body, 'status', ['draft', 'published'], '状态');
    const old = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
    if (!old) return res.status(404).json({ error: '公告不存在' });
    const publishedAt = status === 'published' ? (old.published_at || new Date().toISOString()) : old.published_at;
    db.prepare("UPDATE announcements SET status = ?, published_at = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, publishedAt, id);
    audit(db, req, status === 'published' ? '发布公告' : '撤回公告', `公告#${id}`, old.title);
    res.json({ ok: true, status });
  });

  r.delete('/:id', (req, res) => {
    const id = reqId(req.params.id, '公告 ID');
    const old = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
    if (!old) return res.status(404).json({ error: '公告不存在' });
    db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    audit(db, req, '删除公告', `公告#${id}`, old.title);
    res.json({ ok: true });
  });

  return r;
};
