import { randomUUID } from 'node:crypto';
import type { ComputerControl } from './computer';

export interface DiagnosticWindow {
  pid: number;
  read(): Promise<string>;
  close(): void | Promise<void>;
}
/** Invoked explicitly from the UI. Operates only a newly created, locally owned test window. */
export async function computerDiagnostic(
  computer: ComputerControl,
  create: (title: string, signal: AbortSignal) => Promise<DiagnosticWindow>,
) {
  const title = 'CoSail功能自检 ' + randomUUID().slice(0, 8);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let window: DiagnosticWindow | undefined;
  let step = '打开测试窗口';
  try {
    window = await create(title, controller.signal);
    step = '识别测试窗口';
    const adapter = computer.fork();
    const windows = JSON.parse(
      (await adapter.execute('computer_windows', {}, controller.signal)).text,
    );
    const target = windows.find((w: any) => w.title === title && w.pid === window!.pid);
    if (!target) throw new Error('系统未能识别自检窗口，请检查辅助功能授权');
    step = '截取测试窗口';
    const frame = JSON.parse(
      (await adapter.execute('computer_screenshot', { windowId: target.id }, controller.signal))
        .text,
    );
    step = '输入中文';
    await adapter.execute(
      'computer_type',
      { frameId: frame.frameId, text: 'CoSail自检成功' },
      controller.signal,
    );
    // Synthetic key events are delivered asynchronously (XWayland → Chromium → renderer);
    // poll until the field reflects them instead of reading immediately.
    let parsed = { value: '' };
    for (let attempt = 0; attempt < 20; attempt++) {
      parsed.value = await window.read();
      if (parsed.value === 'CoSail自检成功') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (parsed.value !== 'CoSail自检成功')
      throw new Error(
        '中文输入校验未通过，测试框实际收到：' +
          (parsed.value ? JSON.stringify(parsed.value).slice(0, 100) : '空'),
      );
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
    try {
      await window?.close();
    } finally {
      controller.abort();
    }
  }
}
