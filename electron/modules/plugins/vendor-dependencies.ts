import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { vendorPlugin } from '../../../src/shared/vendor-plugins';
import { minimalEnv } from '../../core/tools/workspace';

const run = promisify(execFile);
const pending = new Map<string, Promise<void>>();
export function installVendorDependencies(id: string, command: string): Promise<void> {
  const preset = vendorPlugin(id);
  if (!preset || !('package' in preset)) throw new Error('该插件没有需要安装的外部依赖');
  const existing = pending.get(id);
  if (existing) return existing;
  const work = (async () => {
    try {
      // Resolve the fixed official package without starting its server or sending API requests.
      await run(
        command,
        ['--from', `${preset.package}==${preset.version}`, 'python', '-c', 'pass'],
        {
          env: minimalEnv(),
          windowsHide: true,
          timeout: 180000,
          maxBuffer: 2_000_000,
        },
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'ENOENT'
          ? '未找到 uvx，请先安装 uv，或填写正确的 uvx 绝对路径'
          : '依赖安装未完成，请检查网络和 uvx 路径后重试',
      );
    }
  })();
  pending.set(id, work);
  void work.finally(() => pending.delete(id)).catch(() => {});
  return work;
}
