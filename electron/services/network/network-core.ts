import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rename, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, unzipSync } from 'fflate';
import { serviceFetch } from './service-network';

export const CORE_VERSION = 'v1.19.32';
const assets: Record<string, [string, string]> = {
  'win32-x64': [
    'mihomo-windows-amd64-compatible-v1.19.32.zip',
    '974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0',
  ],
  'darwin-x64': [
    'mihomo-darwin-amd64-compatible-v1.19.32.gz',
    '18b382df77bded2ad0fb3db27db5636cb15b20729d5ba995a357eeb9b46bf507',
  ],
  'darwin-arm64': [
    'mihomo-darwin-arm64-v1.19.32.gz',
    '3312a6780652c622890fd4357c6a853bbf865464fd047ac7b7f52dab8de18652',
  ],
  'linux-x64': [
    'mihomo-linux-amd64-compatible-v1.19.32.gz',
    'ba3ce607747a07f948fc35780e108a4a7c7f552a38b9bd4d115f313ebcb89c20',
  ],
};
export async function boundedBody(response: Response, max: number) {
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('下载内容超过允许大小');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export class NetworkCore {
  private installing?: Promise<void>;
  readonly asset = assets[`${process.platform}-${process.arch}`];
  readonly directory: string;
  readonly binary: string;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'network-core', CORE_VERSION);
    this.binary = path.join(this.directory, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  }
  status() {
    return {
      installed: existsSync(this.binary),
      version: CORE_VERSION,
      asset: this.asset?.[0] || '此平台暂不支持',
    };
  }
  async install(archive?: Buffer) {
    if (this.installing) return this.installing;
    this.installing = this.performInstall(archive).finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }
  private async performInstall(archive?: Buffer) {
    if (!this.asset) throw new Error('目前支持 Windows x64、macOS Intel / Apple Silicon 与 Linux x64');
    const [name, digest] = this.asset;
    if (this.status().installed) return;
    let bytes = archive;
    if (!bytes) {
      try {
        bytes = await boundedBody(
          await serviceFetch(
            `https://github.com/MetaCubeX/mihomo/releases/download/${CORE_VERSION}/${name}`,
            { signal: AbortSignal.timeout(120000) },
          ),
          60_000_000,
        );
      } catch {
        throw new Error('内核下载失败。可在其他网络下载页面显示的官方压缩包，然后选择“离线安装”。');
      }
    }
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error('内核校验不通过，请使用指定版本的官方压缩包');
    let binary: Uint8Array;
    if (name.endsWith('.zip')) {
      const entries = Object.entries(unzipSync(bytes));
      const executable = entries.filter(([key]) => key.endsWith('.exe'));
      if (executable.length !== 1) throw new Error('内核压缩包无效');
      binary = executable[0][1];
    } else binary = gunzipSync(bytes);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const tmp = this.binary + '.tmp';
    try {
      await writeFile(tmp, binary, { mode: 0o700 });
      await chmod(tmp, 0o700);
      await rename(tmp, this.binary);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  async installFile(file: string) {
    const { stat } = await import('node:fs/promises');
    if ((await stat(file)).size > 60_000_000) throw new Error('压缩包过大');
    return this.install(await readFile(file));
  }
}
