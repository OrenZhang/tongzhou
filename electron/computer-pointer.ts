import { BrowserWindow, screen } from 'electron';

export const POINTER_TITLE = '同舟操作指针';
const labels: Record<string, string> = {
  click: '点击',
  drag: '拖动',
  scroll: '滚动',
  type: '输入',
  key: '快捷键',
  windows: '观察窗口',
  waiting: '等待下一步',
};

/** A click-through, non-focusing marker. Never changes the user's OS cursor. */
export class ComputerPointer {
  private window?: BrowserWindow;
  private tracking?: ReturnType<typeof setInterval>;
  private owner?: AbortSignal;
  private detach?: () => void;

  async show(action: string, owner: AbortSignal) {
    owner.throwIfAborted();
    if (this.owner !== owner) {
      this.hide();
      this.owner = owner;
      const abort = () => this.hide(owner);
      owner.addEventListener('abort', abort, { once: true });
      this.detach = () => owner.removeEventListener('abort', abort);
    }
    if (this.window && !this.window.isDestroyed()) {
      await this.label(action);
      return;
    }
    const window = new BrowserWindow({
      width: 146,
      height: 76,
      title: POINTER_TITLE,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.window = window;
    window.setIgnoreMouseEvents(true);
    window.setAlwaysOnTop(true, 'screen-saver');
    const label = labels[action] ?? '操作';
    await window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`<!doctype html>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>html,body{margin:0;overflow:hidden;background:transparent}svg{position:absolute;left:0;top:0}
      span{position:absolute;left:32px;top:26px;background:#4938dc;color:white;border:1px solid #fff9;
      border-radius:12px;padding:4px 9px;font:12px 'Segoe UI','Microsoft YaHei',sans-serif;white-space:nowrap}
      circle{transform-origin:18px 18px;animation:pulse .85s ease-out infinite}
      @keyframes pulse{from{transform:scale(.4);opacity:1}to{transform:scale(1);opacity:0}}</style>
      <svg width="48" height="56" viewBox="0 0 48 56"><circle cx="18" cy="18" r="16" fill="none" stroke="#8b5cf6" stroke-width="3"/>
      <path d="M18 18 L19 44 L26 37 L32 49 L38 46 L31 34 L41 33 Z" fill="#6750ee" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>
      <span>同舟 · ${label}</span>`),
    );
    if (this.window !== window || window.isDestroyed() || owner.aborted) return;
    const position = () => {
      if (window.isDestroyed()) return;
      // Electron returns desktop DIPs, including negative coordinates on secondary monitors.
      const point = screen.getCursorScreenPoint();
      window.setPosition(point.x - 18, point.y - 18, false);
    };
    position();
    window.showInactive();
    this.tracking = setInterval(position, 25);
  }

  private async label(action: string) {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    await window.webContents.executeJavaScript(
      `document.querySelector('span').textContent = ${JSON.stringify('同舟 · ' + (labels[action] ?? '操作'))}`,
    );
  }

  pause() {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  async finish(owner: AbortSignal) {
    if (this.owner !== owner || owner.aborted) return;
    await this.label('waiting');
    if (this.owner === owner && !owner.aborted && this.window && !this.window.isDestroyed())
      this.window.showInactive();
  }

  hide(owner?: AbortSignal) {
    // An older run ending must not remove another run's current indicator.
    if (owner && this.owner !== owner) return;
    clearInterval(this.tracking);
    this.tracking = undefined;
    this.detach?.();
    this.detach = undefined;
    this.owner = undefined;
    const window = this.window;
    this.window = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
