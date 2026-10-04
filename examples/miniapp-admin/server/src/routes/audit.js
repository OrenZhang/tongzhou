'use strict';
const express = require('express');
const { parsePage, safeKeyword } = require('../util/validate');

module.exports = function auditRoutes(db) {
  const r = express.Router();

  // 审计日志（仅 admin）：关键词（动作/对象/操作人）+ 分页
  r.get('/', (req, res) => {
    const { page, pageSize, offset } = parsePage(req.query);
    const kw = safeKeyword(req.query.keyword);
    const where = kw
      ? "WHERE action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR admin_name LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\'"
      : '';
    const args = kw ? [`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${where}`).get(...args).c;
    const list = db
      .prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, offset);
    res.json({ list, total, page, pageSize });
  });

  return r;
};
