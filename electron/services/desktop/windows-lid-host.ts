import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { WindowsLidPolicy, type LidBackup } from './windows-lid-policy';

// Runs independently so a main-process crash/disconnect still restores the saved AC policy.
const journal = process.argv[2];
if (!journal || process.platform !== 'win32' || !process.send) process.exit(1);
const execute = promisify(execFile);
const policy = new WindowsLidPolicy({
  async run(args) {
    try {
      const { stdout } = await execute(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'powercfg.exe'),
        args,
        { windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024 },
      );
      return stdout;
    } catch {
      throw new Error('无法修改或恢复 Windows 合盖设置，请检查电源管理权限后重试');
    }
  },
  read() {
    if (!existsSync(journal)) return [];
    const rows: LidBackup[] = JSON.parse(readFileSync(journal, 'utf8'));
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(row.scheme) ||
          ![0, 1, 2, 3].includes(row.ac),
      )
    )
      throw new Error('合盖设置恢复记录损坏');
    return rows;
  },
  write(rows) {
    writeFileSync(journal + '.tmp', JSON.stringify(rows));
    renameSync(journal + '.tmp', journal);
  },
});
let stopping = false;
let ownsJournal = false;
let pending = Promise.resolve();
let timer: ReturnType<typeof setInterval> | undefined;
function send(message: object) {
  if (process.connected) process.send!(message, () => {});
}
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await pending.catch(() => {});
  try {
    if (ownsJournal) await policy.restore();
    send({ type: 'restored' });
    process.exitCode = 0;
  } catch (error) {
    send({ type: 'error', message: String(error) });
    process.exitCode = 1;
  }
  if (ownsJournal) {
    unlinkSync(journal + '.lock');
    ownsJournal = false;
  }
  if (process.connected) process.disconnect();
}
process.on('disconnect', () => void stop());
process.on('message', (message) => {
  if (message === 'stop') void stop();
});
process.on('SIGTERM', () => void stop());
pending = (async () => {
  // A replacement app may start while its crashed predecessor's watchdog is restoring.
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      writeFileSync(journal + '.lock', String(process.pid), { flag: 'wx' });
      ownsJournal = true;
      break;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(journal + '.lock', 'utf8'));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('合盖恢复锁损坏');
      try {
        process.kill(owner, 0);
      } catch (error: any) {
        if (error.code === 'ESRCH') {
          unlinkSync(journal + '.lock');
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!ownsJournal) throw new Error('另一个电源管理助手正在恢复设置，请稍后重试');
  await policy.restore();
  if (stopping) return;
  if (process.argv[3] !== 'recover') await policy.enable();
  if (stopping) return;
  send({ type: 'ready' });
  if (process.argv[3] === 'recover') return;
  timer = setInterval(() => {
    pending = pending
      .then(() => (stopping ? undefined : policy.enable()))
      .catch((error) => {
        send({ type: 'error', message: String(error) });
        void stop();
      });
  }, 5000);
})();
pending.catch((error) => {
  send({ type: 'error', message: String(error) });
  void stop();
});
