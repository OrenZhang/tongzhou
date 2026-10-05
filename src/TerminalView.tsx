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
  readOnly = false,
}: {
  api: TongzhouAPI;
  sessionId: string;
  id: string;
  onError: (e: unknown) => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Terminal | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    if (instance.current) instance.current.options.disableStdin = readOnly;
  }, [readOnly]);
  useEffect(() => {
    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: 'Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      disableStdin: readOnly,
      allowProposedApi: false,
      theme: {
        background: '#17191e',
        foreground: '#e4e7ed',
        cursor: '#e4e7ed',
        selectionBackground: '#6688b366',
        black: '#404652',
        red: '#ff8888',
        green: '#83d6a0',
        yellow: '#e9d388',
        blue: '#8bbcff',
        magenta: '#d9a3ef',
        cyan: '#79d8df',
        white: '#e4e7ed',
        brightBlack: '#929bab',
        brightRed: '#ffaaaa',
        brightGreen: '#a2e8b8',
        brightYellow: '#f4df9a',
        brightBlue: '#aad0ff',
        brightMagenta: '#e8baff',
        brightCyan: '#9de7ed',
        brightWhite: '#ffffff',
      },
    });
    instance.current = terminal;
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
        .catch((e) => errorHandler.current(e));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    const input = terminal.onData((data) => {
      void api.writeTerminal(sessionId, id, data).catch((e) => errorHandler.current(e));
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
        if (alive) errorHandler.current(e);
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
      instance.current = null;
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
