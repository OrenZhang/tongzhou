'use strict';
const express = require('express');
const { reqString, optInt, optEnum, reqEnum, reqId } = require('../util/validate');
const { audit } = require('../services/audit');

module.exports = function categoryRoutes(db) {
  const r = express.Router();

  // 全部分类（含每个分类的商品数），供下拉与分类管理页使用
  r.get('/', (req, res) => {
    const list = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
         FROM categories c ORDER BY c.sort ASC, c.id ASC`
      )
      .all();
    res.json({ list });
  });

  r.post('/', (req, res) => {
    const name = reqString(req.body, 'name', { max: 30, name: '分类名称' });
    const sort = optInt(req.body, 'sort', { min: 0, max: 9999, default: 0 });
    const status = optEnum(req.body, 'status', ['on', 'off'], '状态', 'on');
    const exists = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
    if (exists) return res.status(409).json({ error: '分类名称已存在' });
    const info = db.prepare('INSERT INTO categories (name, sort, status) VALUES (?,?,?)').run(name, sort, status);
    audit(db, req, '新增分类', `分类#${Number(info.lastInsertRowid)}`, name);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.put('/:id', (req, res) => {
    const id = reqId(req.params.id, '分类 ID');
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) return res.status(404).json({ error: '分类不存在' });
    const name = reqString(req.body, 'name', { max: 30, name: '分类名称' });
    const sort = optInt(req.body, 'sort', { min: 0, max: 9999, default: cat.sort });
    const status = optEnum(req.body, 'status', ['on', 'off'], '状态', cat.status);
    const dup = db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(name, id);
    if (dup) return res.status(409).json({ error: '分类名称已存在' });
    db.prepare('UPDATE categories SET name = ?, sort = ?, status = ? WHERE id = ?').run(name, sort, status, id);
    audit(db, req, '编辑分类', `分类#${id}`, `${cat.name} → ${name}`);
    res.json({ ok: true });
  });

  // 删除分类：分类下存在商品时禁止删除
  r.delete('/:id', (req, res) => {
    const id = reqId(req.params.id, '分类 ID');
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) return res.status(404).json({ error: '分类不存在' });
    const count = db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ?').get(id).c;
    if (count > 0) return res.status(409).json({ error: `该分类下还有 ${count} 个商品，无法删除` });
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    audit(db, req, '删除分类', `分类#${id}`, cat.name);
    res.json({ ok: true });
  });

  // 快捷上下架
  r.patch('/:id/status', (req, res) => {
    const id = reqId(req.params.id, '分类 ID');
    const status = reqEnum(req.body, 'status', ['on', 'off'], '状态');
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) return res.status(404).json({ error: '分类不存在' });
    db.prepare('UPDATE categories SET status = ? WHERE id = ?').run(status, id);
    audit(db, req, status === 'on' ? '上架分类' : '下架分类', `分类#${id}`, cat.name);
    res.json({ ok: true, status });
  });

  return r;
};
