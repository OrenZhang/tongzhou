/** Electron may silently fail when Windows denies clipboard access (e.g. a locked desktop). */
export async function writeClipboardText(
  clipboard: {
    writeText(text: string): void | Promise<void>;
    readText(): string | Promise<string>;
  },
  text: string,
) {
  try {
    await clipboard.writeText(text);
    if ((await clipboard.readText()) === text) return;
  } catch {
    /* Report a useful failure instead of claiming that copying succeeded. */
  }
  throw new Error('系统剪贴板暂不可用，请解锁桌面或关闭占用剪贴板的程序后重试。');
}
