'use strict';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function label(field, custom) {
  return custom || field;
}

function reqString(obj, field, { min = 1, max = 255, name } = {}) {
  const v = obj ? obj[field] : undefined;
  if (typeof v !== 'string') throw new ValidationError(`${label(field, name)} 必须为字符串`);
  const t = v.trim();
  if (t.length < min) throw new ValidationError(`${label(field, name)} 长度不能少于 ${min} 个字符`);
  if (t.length > max) throw new ValidationError(`${label(field, name)} 长度不能超过 ${max} 个字符`);
  return t;
}

function optString(obj, field, { min = 0, max = 2000, name } = {}) {
  const v = obj ? obj[field] : undefined;
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new ValidationError(`${label(field, name)} 必须为字符串`);
  const t = v.trim();
  if (t.length < min) throw new ValidationError(`${label(field, name)} 长度不能少于 ${min} 个字符`);
  if (t.length > max) throw new ValidationError(`${label(field, name)} 长度不能超过 ${max} 个字符`);
  return t;
}

function reqInt(obj, field, { min = -1e12, max = 1e12, name } = {}) {
  const v = obj ? obj[field] : undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n)) throw new ValidationError(`${label(field, name)} 必须为整数`);
  if (n < min || n > max) throw new ValidationError(`${label(field, name)} 必须在 ${min} ~ ${max} 之间`);
  return n;
}

function optInt(obj, field, opts = {}) {
  const v = obj ? obj[field] : undefined;
  if (v === undefined || v === null || v === '') return opts.default !== undefined ? opts.default : null;
  return reqInt(obj, field, opts);
}

function reqEnum(obj, field, allowed, name) {
  const v = obj ? obj[field] : undefined;
  if (!allowed.includes(v)) throw new ValidationError(`${label(field, name)} 必须是：${allowed.join(' / ')}`);
  return v;
}

function optEnum(obj, field, allowed, name, defaultValue) {
  const v = obj ? obj[field] : undefined;
  if (v === undefined || v === null || v === '') return defaultValue;
  return reqEnum(obj, field, allowed, name);
}

// 价格以“元”接收（支持两位小数），转换为“分”存储
function reqPriceCents(obj, field = 'price', name = '价格') {
  const v = obj ? obj[field] : undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isFinite(n)) throw new ValidationError(`${name} 必须为数字`);
  if (n < 0 || n > 9999999) throw new ValidationError(`${name} 必须在 0 ~ 9,999,999 之间`);
  return Math.round(n * 100);
}

function reqId(param, name = 'ID') {
  const n = Number(param);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${name} 不合法`);
  return n;
}

function parsePage(query = {}) {
  let page = Number(query.page) || 1;
  let pageSize = Number(query.pageSize) || 10;
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = 10;
  if (pageSize > 100) pageSize = 100;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function safeKeyword(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, 50).replace(/[%_]/g, (c) => `\\${c}`);
}

module.exports = {
  ValidationError,
  reqString,
  optString,
  reqInt,
  optInt,
  reqEnum,
  optEnum,
  reqPriceCents,
  reqId,
  parsePage,
  safeKeyword,
};
