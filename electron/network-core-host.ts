// A dedicated supervisor owns the core. IPC disconnect also fires if the desktop crashes.
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
let child: ChildProcess | undefined;
let directory = '';
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  // Keep the supervisor alive after IPC disconnect until its child and temp files are gone.
  const keepAlive = setInterval(() => {}, 1000);
  if (child && child.exitCode === null) {
    await new Promise<void>((resolve) => {
      child!.once('close', () => resolve());
      child!.kill('SIGKILL');
    });
  }
  if (directory) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  }
  clearInterval(keepAlive);
  process.exit(code);
}
process.on('disconnect', () => void close());
process.on('message', (msg: any) => {
  if (msg?.type === 'stop') {
    void close();
    return;
  }
  if (child || closing || msg?.type !== 'start') return;
  directory = msg.directory;
  child = spawn(msg.binary, ['-d', directory, '-f', msg.config], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
    env: msg.env,
  });
  child.once('error', () => void close(1));
  child.once('exit', (code) => {
    if (!closing) void close(code || 1);
  });
});
