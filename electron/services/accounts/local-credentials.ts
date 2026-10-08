import { execFile } from 'node:child_process';
import os from 'node:os';
import { minimalEnv } from '../../core/tools/workspace';

export type LocalCredentialCommand = (
  command: string,
  args: string[],
  input?: string,
  includeStderr?: boolean,
) => Promise<string>;
export const localCredentialCommand: LocalCredentialCommand = (
  command,
  args,
  input,
  includeStderr,
) =>
  new Promise((resolve, reject) => {
    const env = {
      ...minimalEnv(),
      ...(process.platform === 'darwin'
        ? { PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` }
        : {}),
      ...Object.fromEntries(
        ['GH_CONFIG_DIR', 'GLAB_CONFIG_DIR', 'XDG_CONFIG_HOME']
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GH_PROMPT_DISABLED: '1',
      GLAB_PROMPT_DISABLED: '1',
      NO_COLOR: '1',
      CLICOLOR: '0',
    };
    // Credential outputs remain private; errors never include stdout or stderr.
    const child = execFile(
      command,
      args,
      { cwd: os.homedir(), env, windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error('未能读取本地登录状态'))
          : resolve(stdout + (includeStderr ? stderr : '')),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });

export function credentialToken(value: string) {
  const token = value.trim();
  if (!token || token.length > 10000 || /[\s\x00-\x1f\x7f]/.test(token))
    throw new Error('未检测到可用的本地凭据');
  return token;
}
export async function readGitCredential(
  url: URL,
  run: LocalCredentialCommand = localCredentialCommand,
) {
  const output = await run(
    'git',
    ['-c', 'core.askPass=', '-c', 'credential.interactive=false', 'credential', 'fill'],
    `protocol=https\nhost=${url.host}\n\n`,
  );
  const fields = Object.fromEntries(
    output
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  if (fields.protocol !== 'https' || fields.host !== url.host)
    throw new Error('本地凭据不属于指定站点');
  return credentialToken(fields.password ?? '');
}
