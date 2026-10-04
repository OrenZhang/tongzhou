'use strict';

// 统一错误处理：业务错误返回 { error: message }，未知错误不泄露内部细节
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ error: '请求体不是合法的 JSON 或体积过大' });
  }
  const status = Number(err.status) || 500;
  if (status >= 500) console.error('[server]', err);
  res.status(status).json({ error: status >= 500 ? '服务器内部错误' : err.message });
}

function notFoundApi(req, res) {
  res.status(404).json({ error: '接口不存在' });
}

module.exports = { errorHandler, notFoundApi };
