'use strict';
const express = require('express');
const { parsePage, reqEnum, reqId, safeKeyword } = require('../util/validate');
const { audit } = require('../services/audit');

// 合法状态流转：pending→paid/cancelled；paid→shipped/cancelled；shipped→completed；completed/cancelled 为终态
const FLOW = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['completed'],
  completed: [],
  cancelled: [],
};

const STATUS_TEXT = {
  pending: '待支付',
  paid: '待发货',
  shipped: '已发货',
  completed: '已完成',
  cancelled: '已取消',
};

module.exports = function orderRoutes(db) {
  const r = express.Router();
  r.FLOW = FLOW;

  // 订单列表：状态筛选 + 订单号搜索 + 分页
  r.get('/', (req, res) => {
    const { page, pageSize, offset } = parsePage(req.query);
    const status = Object.keys(FLOW).includes(req.query.status) ? req.query.status : '';
    const kw = safeKeyword(req.query.keyword);
    const conds = [];
    const args = [];
    if (status) {
      conds.push('o.status = ?');
      args.push(status);
    }
    if (kw) {
      conds.push('o.order_no LIKE ? ESCAPE \'\\\'');
      args.push(`%${kw}%`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM orders o ${where}`).get(...args).c;
    const list = db
      .prepare(
        `SELECT o.id, o.order_no, o.status, o.total_cents, o.created_at, o.remark, u.nickname AS user_nickname
         FROM orders o JOIN users u ON u.id = o.user_id
         ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, pageSize, offset);
    res.json({ list, total, page, pageSize });
  });

  // 订单详情：订单 + 明细 + 下单用户
  r.get('/:id', (req, res) => {
    const id = reqId(req.params.id, '订单 ID');
    const order = db
      .prepare(
        `SELECT o.*, u.nickname AS user_nickname, u.phone AS user_phone
         FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`
      )
      .get(id);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC').all(id);
    res.json({ order, items });
  });

  // 订单状态流转（仅合法流转被允许）
  r.patch('/:id/status', (req, res) => {
    const id = reqId(req.params.id, '订单 ID');
    const next = reqEnum(req.body, 'status', Object.keys(FLOW), '目标状态');
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    const allowed = FLOW[order.status] || [];
    if (!allowed.includes(next)) {
      return res.status(400).json({
        error: `订单当前状态为「${STATUS_TEXT[order.status]}」，不允许流转到「${STATUS_TEXT[next]}」`,
        allowed,
      });
    }
    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(next, id);
    audit(
      db,
      req,
      '订单状态流转',
      `订单#${id}（${order.order_no}）`,
      `${STATUS_TEXT[order.status]} → ${STATUS_TEXT[next]}`
    );
    res.json({ ok: true, status: next });
  });

  return r;
};
