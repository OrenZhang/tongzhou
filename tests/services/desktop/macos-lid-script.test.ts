import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  macLidAuthorization,
  macLidScript,
} from '../../../electron/services/desktop/macos-lid-script';

const bash =
  process.platform === 'win32'
    ? [
        process.env.TONGZHOU_TEST_BASH,
        'C:/Software/Git/bin/bash.exe',
        'C:/Program Files/Git/bin/bash.exe',
      ].find((file) => file && existsSync(file))
    : '/bin/bash';
const token = '0123456789abcdef0123456789abcdef';

it('rejects arguments that could escape administrator command quoting', () => {
  expect(() => macLidAuthorization(-1, token)).toThrow();
  expect(() => macLidAuthorization(123, '$(touch /tmp/untrusted)')).toThrow();
  const command = macLidAuthorization(123, token);
  expect(command).toContain('with administrator privileges');
  expect(command).not.toContain('sudoers');
});

// Execute the real watchdog logic against fake macOS commands; never invoke real pmset or elevation.
describe.skipIf(!bash)('macOS privileged watchdog with simulated OS commands', () => {
  async function fixture() {
    await mkdir('test-results', { recursive: true });
    const root = await mkdtemp(path.resolve('test-results/mac-power-'));
    await mkdir(path.join(root, 'bin'));
    for (const [name, body] of Object.entries({
      id: 'echo 0',
      stat: "echo '0 755'",
      ps: 'if [ "$2" != 99999 ] || [ "$(cat alive)" = 1 ]; then echo "start-$2"; fi',
      pmset: `if [ "$1" = -g ] && [ "$2" = batt ]; then
  echo "Now drawing from '$(cat source)'"
elif [ "$1" = -g ]; then
  echo "SleepDisabled $(cat value)"
elif [ "$1" = -a ] && [ "$2" = disablesleep ]; then
  echo "$3" > value
else exit 1; fi`,
    }))
      await writeFile(path.join(root, 'bin', name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
    await writeFile(path.join(root, 'source'), 'AC Power');
    await writeFile(path.join(root, 'alive'), '1');
    await writeFile(path.join(root, 'value'), '0');
    const script = macLidScript
      .replace('PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'PATH="$PWD/bin":/usr/bin:/bin')
      .replace('directory=/var/run/org.tongzhou.power', 'directory="$PWD/state"')
      .replaceAll('/usr/bin/pmset', '"$PWD/bin/pmset"');
    const start = () => {
      const child = spawn(bash!, ['-c', script, '--', '99999', token, 'enable'], {
        cwd: root,
        windowsHide: true,
      });
      let output = '';
      child.stderr.on('data', (data) => {
        output += data;
      });
      const done = new Promise<number | null>((resolve) => child.once('exit', resolve));
      return { child, done, output: () => output };
    };
    const value = async () => (await readFile(path.join(root, 'value'), 'utf8')).trim();
    const status = async () =>
      (await readFile(path.join(root, 'state', 'status-' + token), 'utf8').catch(() => '')).trim();
    return { root, start, value, status };
  }
  it.each(['battery', 'owner-exit'])('restores original sleep settings on %s', async (reason) => {
    const f = await fixture();
    const run = f.start();
    try {
      await expect.poll(f.status).toBe(token + ' active');
      expect(await f.value()).toBe('1');
      await writeFile(
        path.join(f.root, reason === 'battery' ? 'source' : 'alive'),
        reason === 'battery' ? 'Battery Power' : '0',
      );
      await expect.poll(f.status).toBe(token + ' restored');
      await run.done;
      expect(await f.value()).toBe('0');
      expect(existsSync(path.join(f.root, 'state', 'original'))).toBe(false);
    } finally {
      run.child.kill();
    }
  });
  it('preserves a preexisting system sleep override', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'value'), '1');
    const run = f.start();
    try {
      await expect.poll(f.status).toBe(token + ' active');
      await writeFile(path.join(f.root, 'alive'), '0');
      await expect.poll(f.status).toBe(token + ' restored');
      await run.done;
      expect(await f.value()).toBe('1');
    } finally {
      run.child.kill();
    }
  });
});
