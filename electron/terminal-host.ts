import * as pty from 'node-pty';

// Native PTY runs under bundled Node, independent of Electron's native ABI.
let terminal: pty.IPty | undefined;
process.on('message', (m: any) => {
  try {
    if (m.type === 'start' && !terminal) {
      terminal = pty.spawn(m.shell, m.args, {
        cwd: m.cwd,
        env: m.env,
        cols: 100,
        rows: 30,
        name: 'xterm-256color',
      });
      terminal.onData((data) => process.send?.({ type: 'data', data }));
      terminal.onExit((e) => {
        process.send?.({ type: 'exit', code: e.exitCode });
        setTimeout(() => process.exit(), 30);
      });
      process.send?.({ type: 'ready' });
    } else if (m.type === 'write') terminal?.write(m.data);
    else if (m.type === 'resize') terminal?.resize(m.cols, m.rows);
    else if (m.type === 'stop') {
      terminal?.kill();
      setTimeout(() => process.exit(), 500).unref();
    }
  } catch (e) {
    process.send?.({ type: 'error', error: String(e) });
    process.exitCode = 1;
    terminal?.kill();
  }
});
process.on('disconnect', () => {
  terminal?.kill();
  process.exit();
});
