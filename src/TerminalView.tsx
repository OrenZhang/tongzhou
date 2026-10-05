import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TongzhouAPI } from './shared/types';
export default function TerminalView({
  api,
  sessionId,
  id,
  onError,
}: {
  api: TongzhouAPI;
  sessionId: string;
  id: string;
  onError: (e: unknown) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: 'Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#17191e', foreground: '#e4e7ed' },
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current!);
    terminal.focus();
    let alive = true,
      offset = 0,
      busy = false;
    const resize = () => {
      if (!alive) return;
      fit.fit();
      void api
        .resizeTerminal(sessionId, id, Math.max(20, terminal.cols), Math.max(5, terminal.rows))
        .catch(onError);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    const input = terminal.onData((data) => {
      void api.writeTerminal(sessionId, id, data).catch(onError);
    });
    const poll = async () => {
      if (busy || !alive) return;
      busy = true;
      try {
        const r = await api.readTerminal(sessionId, id, offset);
        if (!alive) return;
        if (r.offset > offset) terminal.writeln('\r\n[较早日志已截断]\r\n');
        terminal.write(r.output);
        offset = r.nextOffset;
      } catch (e) {
        if (alive) onError(e);
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 500);
    return () => {
      alive = false;
      clearInterval(timer);
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [api, sessionId, id]);
  return (
    <div
      className="task-terminal"
      ref={host}
      onKeyDown={(e) => e.stopPropagation()}
      aria-label="交互终端"
    />
  );
}
