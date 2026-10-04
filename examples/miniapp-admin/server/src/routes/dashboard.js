'use strict';
const express = require('express');

module.exports = function dashboardRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const one = (sql, ...args) => db.prepare(sql).get(...args);

    const usersTotal = one('SELECT COUNT(*) AS c FROM users').c;
    const usersToday = one("SELECT COUNT(*) AS c FROM users WHERE date(created_at) = date('now','localtime')").c;
    const ordersTotal = one('SELECT COUNT(*) AS c FROM orders').c;
    const ordersToday = one("SELECT COUNT(*) AS c FROM orders WHERE date(created_at) = date('now','localtime')").c;
    const pendingShip = one("SELECT COUNT(*) AS c FROM orders WHERE status = 'paid'").c;
    const gmvCents =
      one("SELECT COALESCE(SUM(total_cents),0) AS s FROM orders WHERE status IN ('paid','shipped','completed')").s;
    const gmvTodayCents = one(
      "SELECT COALESCE(SUM(total_cents),0) AS s FROM orders WHERE status IN ('paid','shipped','completed') AND date(created_at) = date('now','localtime')"
    ).s;
    const productsOn = one("SELECT COUNT(*) AS c FROM products WHERE status = 'on'").c;
    const usersDisabled = one("SELECT COUNT(*) AS c FROM users WHERE status = 'disabled'").c;

    const recentOrders = db
      .prepare(
        `SELECT o.id, o.order_no, o.status, o.total_cents, o.created_at, u.nickname AS user_nickname
         FROM orders o JOIN users u ON u.id = o.user_id
         ORDER BY o.id DESC LIMIT 8`
      )
      .all();

    // 近 7 天趋势（含无订单日期补零）
    const rows = db
      .prepare(
        `SELECT date(created_at) AS d, COUNT(*) AS order_count, COALESCE(SUM(total_cents),0) AS gmv_cents
         FROM orders
         WHERE created_at >= datetime('now','localtime','-6 days','start of day') AND status != 'cancelled'
         GROUP BY date(created_at)`
      )
      .all();
    const byDate = new Map(rows.map((x) => [x.d, x]));
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const row = byDate.get(key);
      trend.push({ date: key.slice(5), order_count: row ? row.order_count : 0, gmv_cents: row ? row.gmv_cents : 0 });
    }

    res.json({
      stats: {
        usersTotal,
        usersToday,
        usersDisabled,
        ordersTotal,
        ordersToday,
        pendingShip,
        gmvCents,
        gmvTodayCents,
        productsOn,
      },
      recentOrders,
      trend,
    });
  });

  return r;
};
