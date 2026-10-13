import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import type { SecretCodec } from './store';

const prefix = 'local-v1:';
const context = Buffer.from('Tongzhou local secret v1');
export const localSecretKeyFile = 'local-secret.key';

/** Local encryption without OS credential APIs. Legacy ciphertext is preserved,
 * never decrypted implicitly: replacing a token is an explicit user operation. */
export function localSecretCodec(dataDir: string): SecretCodec {
  const keyPath = path.join(dataDir, localSecretKeyFile);
  function key(create: boolean) {
    if (create && !existsSync(keyPath)) {
      mkdirSync(dataDir, { recursive: true });
      let fd: number | undefined;
      try {
        fd = openSync(keyPath, 'wx', 0o600);
        writeFileSync(fd, randomBytes(32));
        fsyncSync(fd);
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw new Error('无法保存本地密钥文件，请检查数据目录权限。');
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (!existsSync(keyPath)) throw new Error('本地密钥文件缺失，请重新填写连接密钥。');
    const value = readFileSync(keyPath);
    if (value.length !== 32) throw new Error('本地密钥文件已损坏，请恢复原文件。');
    chmodSync(keyPath, 0o600);
    return value;
  }
  return {
    needsReplacement: (value) => !value.startsWith(prefix) || !existsSync(keyPath),
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(true), iv);
      cipher.setAAD(context);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return prefix + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt(value) {
      if (!value.startsWith(prefix))
        throw new Error('此密钥仍为旧版钥匙串格式。已停止访问钥匙串，请重新填写并保存密钥。');
      const payload = Buffer.from(value.slice(prefix.length), 'base64');
      const localKey = key(false);
      try {
        const decipher = createDecipheriv('aes-256-gcm', localKey, payload.subarray(0, 12));
        decipher.setAAD(context);
        decipher.setAuthTag(payload.subarray(12, 28));
        return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString(
          'utf8',
        );
      } catch {
        throw new Error('本地密钥无法解密，请检查原密钥文件或重新填写连接密钥。');
      }
    },
  };
}
