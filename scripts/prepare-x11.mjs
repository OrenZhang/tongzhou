import { copyFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Linux computer control uses a bundled N-API addon (ABI-stable, no per-Electron rebuild).
// Requires system headers: libx11-dev libxtst-dev.
if (process.platform === 'linux') {
  const directory = path.resolve('build/computer/linux-x11');
  const target = path.join(directory, 'computer-x11.node');
  const source = path.join(directory, 'build/Release/computer_x11.node');
  const input = path.join(directory, 'computer_x11.c');
  const stale =
    !existsSync(target) || !existsSync(source) || statSync(input).mtimeMs > statSync(target).mtimeMs;
  if (stale) {
    const result = spawnSync(
      process.execPath,
      [path.resolve('node_modules/node-gyp/bin/node-gyp.js'), 'rebuild'],
      { cwd: directory, stdio: 'inherit' },
    );
    if (result.status !== 0)
      throw new Error(
        'computer-x11 原生模块编译失败：请先安装开发头文件（sudo apt install libx11-dev libxtst-dev）',
      );
    copyFileSync(source, target);
  }
}
