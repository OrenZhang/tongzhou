import { execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { macLidAuthorization, macLidDirectory } from './macos-lid-script';

if (process.platform !== 'darwin' || !process.send) process.exit(1);
const token = randomBytes(16).toString('hex');
const recover = process.argv[3] === 'recover';
const send = (message: object) => {
  if (process.connected) process.send!(message, () => {});
};
send({ type: 'session', token });
// The privileged watchdog watches this process. Disconnect/stop exits it, releasing the lease.
let authorization: ChildProcess | undefined;
const stop = () => {
  authorization?.kill('SIGTERM');
  process.exit(0);
};
process.on('disconnect', stop);
process.on('message', (message) => {
  if (message === 'stop') stop();
});
process.on('SIGTERM', stop);
authorization = execFile(
  '/usr/bin/osascript',
  ['-e', macLidAuthorization(process.pid, token, recover)],
  { timeout: 120000 },
  async (error) => {
    authorization = undefined;
    if (error) {
      send({ type: 'error', message: '未获得 macOS 管理员授权，合盖保持唤醒未启用' });
      process.exitCode = 1;
      if (process.connected) process.disconnect();
      return;
    }
    let ready = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      const status = await readFile(macLidDirectory + '/status-' + token, 'utf8').catch(() => '');
      const [currentToken, phase] = status.trim().split(' ');
      if (currentToken === token && (phase === 'active' || (recover && phase === 'restored'))) {
        if (!ready) {
          ready = true;
          send({ type: 'ready', token });
        }
      } else if (currentToken === token && phase) {
        clearInterval(timer);
        send({
          type: 'error',
          message:
            phase === 'busy'
              ? '另一CoSail实例正在管理合盖设置'
              : phase === 'restore-error'
                ? 'macOS 睡眠设置恢复失败，请重新授权恢复'
                : '已停止合盖保持唤醒（电源断开或辅助进程退出）',
        });
        if (process.connected) process.disconnect();
      } else if (!ready && Date.now() - started > 15000) {
        clearInterval(timer);
        send({ type: 'error', message: 'macOS 电源管理助手启动失败，请重试' });
        if (process.connected) process.disconnect();
      }
    }, 500);
  },
);
