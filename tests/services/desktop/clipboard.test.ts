import { expect, it, vi } from 'vitest';
import { writeClipboardText } from '../../../electron/services/desktop/clipboard';

it('only reports successful copying after the system confirms the exact text', async () => {
  let value = '';
  const clipboard = {
    writeText: (text: string) => {
      value = text;
    },
    readText: () => value,
  };
  await expect(writeClipboardText(clipboard, '中文\ncode()')).resolves.toBeUndefined();
  expect(value).toBe('中文\ncode()');
});
it('surfaces silent access-denied writes and thrown OS failures without returning clipboard data', async () => {
  await expect(
    writeClipboardText({ writeText: vi.fn(), readText: () => '' }, 'fixture'),
  ).rejects.toThrow('剪贴板暂不可用');
  await expect(
    writeClipboardText(
      {
        writeText: () => {
          throw new Error('private diagnostic');
        },
        readText: vi.fn(),
      },
      'fixture',
    ),
  ).rejects.toThrow('剪贴板暂不可用');
});
it('awaits asynchronous Electron clipboard writes and reads before confirming', async () => {
  let value = '';
  await expect(
    writeClipboardText(
      {
        writeText: async (text) => {
          await Promise.resolve();
          value = text;
        },
        readText: async () => value,
      },
      '异步复制',
    ),
  ).resolves.toBeUndefined();
  await expect(
    writeClipboardText(
      {
        writeText: async () => {
          throw new Error('access denied');
        },
        readText: async () => '',
      },
      'fixture',
    ),
  ).rejects.toThrow('剪贴板暂不可用');
});
