'use strict';
const express = require('express');
const { parsePage, reqString, optString, reqInt, optEnum, reqEnum, reqId, reqPriceCents, safeKeyword } = require('../util/validate');
const { audit } = require('../services/audit');

function readProductBody(db, body, forUpdate = false, old = null) {
  const name = reqString(body, 'name', { max: 60, name: '商品名称' });
  const categoryId = reqId(body.categoryId ?? body.category_id ?? 0, '分类');
  const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!cat) {
    const e = new Error('所选分类不存在');
    e.status = 400;
    throw e;
  }
  const priceCents = reqPriceCents(body, 'price', '价格');
  const stock = reqInt(body, 'stock', { min: 0, max: 999999, name: '库存' });
  const description = optString(body, 'description', { max: 2000, name: '商品描述' });
  const cover = optString(body, 'cover', { max: 300, name: '封面' });
  const status = optEnum(body, 'status', ['on', 'off'], '状态', forUpdate ? old.status : 'off');
  return { name, categoryId, priceCents, stock, description, cover, status };
}

module.exports = function productRoutes(db) {
  const r = express.Router();

  // 商品列表：关键词 + 分类 + 状态 + 分页
  r.get('/', (req, res) => {
    const { page, pageSize, offset } = parsePage(req.query);
    const status = req.query.status === 'on' || req.query.status === 'off' ? req.query.status : '';
    const categoryId = Number(req.query.categoryId) || 0;
    const kw = safeKeyword(req.query.keyword);
    const conds = [];
    const args = [];
    if (kw) {
      conds.push('p.name LIKE ? ESCAPE \'\\\'');
      args.push(`%${kw}%`);
    }
    if (status) {
      conds.push('p.status = ?');
      args.push(status);
    }
    if (categoryId) {
      conds.push('p.category_id = ?');
      args.push(categoryId);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM products p ${where}`).get(...args).c;
    const list = db
      .prepare(
        `SELECT p.*, c.name AS category_name
         FROM products p JOIN categories c ON c.id = p.category_id
         ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, pageSize, offset);
    res.json({ list, total, page, pageSize });
  });

  r.post('/', (req, res) => {
    const p = readProductBody(db, req.body);
    const info = db
      .prepare('INSERT INTO products (category_id, name, description, price_cents, stock, cover, status) VALUES (?,?,?,?,?,?,?)')
      .run(p.categoryId, p.name, p.description, p.priceCents, p.stock, p.cover, p.status);
    const id = Number(info.lastInsertRowid);
    audit(db, req, '新增商品', `商品#${id}`, `${p.name}（¥${(p.priceCents / 100).toFixed(2)}，库存 ${p.stock}）`);
    res.status(201).json({ id });
  });

  r.put('/:id', (req, res) => {
    const id = reqId(req.params.id, '商品 ID');
    const old = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!old) return res.status(404).json({ error: '商品不存在' });
    const p = readProductBody(db, req.body, true, old);
    db.prepare(
      `UPDATE products SET category_id = ?, name = ?, description = ?, price_cents = ?, stock = ?, cover = ?, status = ?, updated_at = datetime('now','localtime')
       WHERE id = ?`
    ).run(p.categoryId, p.name, p.description, p.priceCents, p.stock, p.cover, p.status, id);
    audit(db, req, '编辑商品', `商品#${id}`, old.name === p.name ? p.name : `${old.name} → ${p.name}`);
    res.json({ ok: true });
  });

  // 上架 / 下架
  r.patch('/:id/status', (req, res) => {
    const id = reqId(req.params.id, '商品 ID');
    const status = reqEnum(req.body, 'status', ['on', 'off'], '状态');
    const old = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!old) return res.status(404).json({ error: '商品不存在' });
    db.prepare("UPDATE products SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, id);
    audit(db, req, status === 'on' ? '上架商品' : '下架商品', `商品#${id}`, old.name);
    res.json({ ok: true, status });
  });

  return r;
};
