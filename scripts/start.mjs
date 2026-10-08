import { spawn } from 'node:child_process';
import electron from 'electron';
import { prepareMacDevelopmentApp } from './macos-dev-app.mjs';

const executable = await prepareMacDevelopmentApp(electron);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill());
