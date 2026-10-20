import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { command } from '../../core/tools/workspace';
import { x11Run } from './linux-computer';
export async function computerHelper(
  payload: unknown,
  signal: AbortSignal,
  restoreClipboard?: (text: string) => void | Promise<void>,
) {
  if (process.platform === 'linux') {
    signal.throwIfAborted();
    try {
      return await x11Run(payload, signal, restoreClipboard);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Could not focus'))
        throw new Error(
          '无法聚焦目标窗口。请将CoSail置于前台批准操作，或先点击目标窗口使其获得键盘焦点后重试。未发送输入。',
        );
      if (message.includes('focus was lost'))
        throw new Error(
          '输入过程中目标窗口失去了键盘焦点，字符可能未完整送入。请重新截图确认，必要时先点击目标窗口再输入。',
        );
      throw new Error('电脑操作失败，请检查系统权限与目标窗口状态。');
    }
  }
  const root = path
    .join(__dirname, '../build/computer')
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const json = JSON.stringify(payload);
  const windowsCode =
    process.platform === 'win32'
      ? (await readFile(path.join(root, 'windows.ps1'), 'utf8')).replace(
          'param([string]$PayloadBase64)',
          "$PayloadBase64 = '" + Buffer.from(json).toString('base64') + "'",
        )
      : '';
  const output =
    process.platform === 'win32'
      ? await command(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-OutputFormat',
            'Text',
            '-EncodedCommand',
            Buffer.from(windowsCode, 'utf16le').toString('base64'),
          ],
          root,
          signal,
          30000,
        )
      : await command(
          '/usr/bin/osascript',
          ['-l', 'JavaScript', path.join(root, 'macos.js'), json],
          root,
          signal,
          30000,
        );
  if (!output.startsWith('exit code: 0\n')) {
    if (output.includes('Could not focus'))
      throw new Error(
        '无法聚焦目标窗口。请将CoSail置于前台批准操作，或手动激活目标窗口后重试。未发送输入。',
      );
    if (output.includes('Windows blocked input'))
      throw new Error('系统拒绝向此窗口输入。不支持管理员或受保护窗口。');
    throw new Error('电脑操作失败，请检查系统权限与目标窗口状态。');
  }
  return JSON.parse(output.slice('exit code: 0\n'.length).trim());
}
