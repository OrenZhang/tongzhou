import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { DesktopComputer } from './computer';

/** Invoked explicitly from the UI. Operates only a newly created, locally owned test window. */
export async function computerDiagnostic(computer: DesktopComputer) {
  const title = '同舟功能自检 ' + randomUUID().slice(0, 8);
  const window = new BrowserWindow({
    width: 600,
    height: 300,
    title,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  window.on('closed', () => controller.abort());
  let step = '打开测试窗口';
  try {
    await window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<html><meta charset="utf-8"><title>${title}</title><h2>同舟电脑控制自检</h2><p>只在此窗口验证截图与中文输入，数据不会发送到外部。</p><input id="sample" autofocus style="font-size:24px" /></html>`,
        ),
    );
    window.show();
    window.focus();
    await window.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    step = '识别测试窗口';
    const adapter = computer.fork();
    const windows = JSON.parse(
      (await adapter.execute('computer_windows', {}, controller.signal)).text,
    );
    const target = windows.find((w: any) => w.title === title && w.pid === process.pid);
    if (!target) throw new Error('系统未能识别自检窗口，请检查辅助功能授权');
    step = '截取测试窗口';
    const frame = JSON.parse(
      (await adapter.execute('computer_screenshot', { windowId: target.id }, controller.signal))
        .text,
    );
    step = '输入中文';
    await adapter.execute(
      'computer_type',
      { frameId: frame.frameId, text: '同舟自检成功' },
      controller.signal,
    );
    // Synthetic key events are delivered asynchronously (XWayland → Chromium → renderer);
    // poll until the field reflects them instead of reading immediately.
    let parsed = { value: '', focus: false, active: '' };
    for (let attempt = 0; attempt < 20; attempt++) {
      const value = await window.webContents.executeJavaScript(
        'JSON.stringify({value: document.querySelector("#sample").value, focus: document.hasFocus(), active: document.activeElement?.id || document.activeElement?.tagName})',
      );
      parsed = JSON.parse(value) as { value: string; focus: boolean; active: string };
      if (parsed.value === '同舟自检成功') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (parsed.value !== '同舟自检成功')
      throw new Error('中文输入未到达自检窗口，请重新聚焦后再试');
    step = '再次验证截图';
    await adapter.execute('computer_screenshot', { windowId: target.id }, controller.signal);
    return { ok: true, time: Date.now(), detail: '本机窗口发现、截图与中文输入均通过' };
  } catch (error) {
    return {
      ok: false,
      time: Date.now(),
      detail: controller.signal.aborted
        ? '检测已取消或超时，请保持测试窗口可见后重新检测。'
        : `${step}未完成：${(error instanceof Error ? error.message : String(error)).slice(0, 450)}`,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (!window.isDestroyed()) window.destroy();
  }
}
