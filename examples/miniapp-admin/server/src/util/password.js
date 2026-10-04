'use strict';
const crypto = require('crypto');

const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored || '').split(':');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(password), salt, KEY_LEN);
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
