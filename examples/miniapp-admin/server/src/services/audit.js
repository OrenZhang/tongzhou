'use strict';

// 操作审计：所有关键写操作留痕。失败不阻断业务，但输出错误便于排查。
function audit(db, req, action, target, detail) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (admin_id, admin_name, action, target, detail, ip) VALUES (?,?,?,?,?,?)'
    ).run(
      req.admin ? req.admin.id : null,
      req.admin ? req.admin.name || req.admin.username : '系统',
      action,
      target || '',
      typeof detail === 'string' ? detail : JSON.stringify(detail || ''),
      req.ip || ''
    );
  } catch (e) {
    console.error('[audit] 写入失败:', e.message);
  }
}

module.exports = { audit };
