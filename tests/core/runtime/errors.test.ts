import { describe, expect, it } from 'vitest';
import { modelErrorMessage } from '../../../electron/core/runtime/errors';
import { redact } from '../../../electron/services/storage/validation';

describe('model error presentation', () => {
  it('extracts a gateway error transported as a serialized HTTP response', () => {
    const text = '当前同舟版本不支持此 Kimi 模型协议';
    expect(modelErrorMessage(new Error(JSON.stringify({ error: { message: text } })))).toBe(text);
  });
  it('unwraps nested gateway errors', () => {
    const inner = JSON.stringify({ error: { message: '模型额度不足' } });
    expect(modelErrorMessage(new Error(JSON.stringify({ message: inner })))).toBe('模型额度不足');
  });
  it('retains messages on error-like objects', () => {
    expect(modelErrorMessage({ message: '模型连接失败' })).toBe('模型连接失败');
  });
  it.each(['连接超时', '{malformed', '{"error":{"code":400}}', '{"message":""}'])(
    'keeps non-message errors intact: %s',
    (text) => expect(modelErrorMessage(new Error(text))).toBe(text),
  );
  it('allows credential redaction after JSON escape sequences have been decoded', () => {
    const secret = 'token-with-"quotes"';
    const text = modelErrorMessage(new Error(JSON.stringify({ error: { message: secret } })));
    expect(redact(text, [secret])).not.toContain(secret);
  });
});
