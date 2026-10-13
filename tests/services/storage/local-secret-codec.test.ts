import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  localSecretCodec,
  localSecretKeyFile,
} from '../../../electron/services/storage/local-secret-codec';
import { createSecretCodec } from '../../../electron/services/desktop/secret-store';
import { Store } from '../../../electron/services/storage/store';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-local-secret-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('never obtains OS storage on macOS, even when an old key is read', () => {
  const root = fixture();
  const os = vi.fn(() => {
    throw new Error('OS storage must not be accessed');
  });
  const codec = createSecretCodec(root, 'darwin', os);
  expect(codec.needsReplacement!('legacy')).toBe(true);
  expect(() => codec.decrypt('legacy')).toThrow('重新填写');
  expect(existsSync(path.join(root, localSecretKeyFile))).toBe(false);
  const sealed = codec.encrypt('fixture-secret');
  expect(codec.decrypt(sealed)).toBe('fixture-secret');
  expect(os).not.toHaveBeenCalled();
});

it('keeps encrypted values readable after restart with a private, stable local key', () => {
  const root = fixture();
  const codec = localSecretCodec(root);
  const first = codec.encrypt('中文 fixture-secret');
  const second = codec.encrypt('中文 fixture-secret');
  expect(first).not.toBe(second);
  expect(first).not.toContain('fixture-secret');
  const key = readFileSync(path.join(root, localSecretKeyFile));
  expect(key.length).toBe(32);
  expect(localSecretCodec(root).decrypt(first)).toBe('中文 fixture-secret');
  expect(readFileSync(path.join(root, localSecretKeyFile))).toEqual(key);
  if (process.platform !== 'win32')
    expect(statSync(path.join(root, localSecretKeyFile)).mode & 0o777).toBe(0o600);
});

it('rejects tampered ciphertext and a different profile key', () => {
  const codec = localSecretCodec(fixture());
  const sealed = codec.encrypt('fixture-secret');
  const bytes = Buffer.from(sealed.slice('local-v1:'.length), 'base64');
  bytes[bytes.length - 1] ^= 1;
  expect(() => codec.decrypt('local-v1:' + bytes.toString('base64'))).toThrow('无法解密');
  const other = localSecretCodec(fixture());
  other.encrypt('other');
  expect(() => other.decrypt(sealed)).toThrow('无法解密');
});

it('does not regenerate missing or corrupt keys while reading saved values', () => {
  const root = fixture();
  const codec = localSecretCodec(root);
  const sealed = codec.encrypt('fixture-secret');
  const keyPath = path.join(root, localSecretKeyFile);
  rmSync(keyPath);
  expect(() => localSecretCodec(root).decrypt(sealed)).toThrow('文件缺失');
  expect(existsSync(keyPath)).toBe(false);
  writeFileSync(keyPath, 'corrupt');
  expect(() => localSecretCodec(root).decrypt(sealed)).toThrow('已损坏');
  expect(() => codec.encrypt('replacement')).toThrow('已损坏');
  expect(readFileSync(keyPath, 'utf8')).toBe('corrupt');
});

it('retains legacy ciphertext on configuration-only saves and replaces it only with a supplied token', () => {
  const root = fixture();
  const store = new Store(':memory:', localSecretCodec(root));
  try {
    store.put('provider', {
      id: 'fixture',
      name: 'fixture',
      protocol: 'openai-chat',
      auth: 'api-key',
      baseUrl: 'https://example.invalid/v1',
      models: ['fixture'],
      maxOutputTokens: 512,
      contextChars: 0,
    });
    store.db.prepare('INSERT INTO secrets VALUES(?,?)').run('fixture', 'legacy-fixture-ciphertext');
    const before = store.providers().find((p) => p.id === 'fixture')!;
    expect(before).toMatchObject({ hasSecret: true, secretNeedsUpdate: true });
    store.saveProvider({ ...before, name: 'renamed', secret: '' });
    expect(store.db.prepare('SELECT value FROM secrets WHERE id=?').get('fixture')).toEqual({
      value: 'legacy-fixture-ciphertext',
    });
    expect(() => store.secret('fixture')).toThrow('钥匙串');
    expect(existsSync(path.join(root, localSecretKeyFile))).toBe(false);
    expect(store.saveProvider({ ...before, secret: 'replacement-fixture' })).toMatchObject({
      hasSecret: true,
      secretNeedsUpdate: false,
    });
    expect(store.secret('fixture')).toBe('replacement-fixture');
    expect(store.get('provider', 'fixture')).not.toHaveProperty('secretNeedsUpdate');
    expect(JSON.stringify(store.providers())).not.toContain('replacement-fixture');
  } finally {
    store.close();
  }
});

it('keeps Windows/Linux system encryption and rejects the Linux plaintext backend', () => {
  const storage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
  } as any;
  const windows = createSecretCodec(fixture(), 'win32', () => storage);
  expect(windows.decrypt(windows.encrypt('fixture'))).toBe('fixture');
  const linux = createSecretCodec(fixture(), 'linux', () => storage);
  expect(() => linux.encrypt('fixture')).toThrow('拒绝明文');
});
