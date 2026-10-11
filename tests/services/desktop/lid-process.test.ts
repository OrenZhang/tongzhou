import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fork: vi.fn(), exists: vi.fn(() => false) }));
vi.mock('node:child_process', () => ({ fork: mocks.fork }));
vi.mock('node:fs', () => ({ existsSync: mocks.exists, readFileSync: vi.fn() }));
import { LidProcess } from '../../../electron/services/desktop/lid-process';

beforeEach(() => {
  vi.clearAllMocks();
});
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
    disconnect: vi.fn(),
  });
  mocks.fork.mockReturnValue(child);
  const failed = vi.fn();
  const lid = new LidProcess('node', 'bundle', 'profile', failed, 'win32');
  return { child, failed, lid };
}
it('does not report the lid enabled until the helper confirms it, and awaits restoration on stop', async () => {
  const { child, lid } = fixture();
  const enabled = vi.fn();
  const starting = lid.setEnabled(true).then(enabled);
  await Promise.resolve();
  expect(enabled).not.toHaveBeenCalled();
  child.emit('message', { type: 'ready' });
  await starting;
  const stopped = vi.fn();
  const stopping = lid.setEnabled(false).then(stopped);
  expect(child.send).toHaveBeenCalledWith('stop');
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  child.emit('exit', 0);
  await stopping;
  expect(stopped).toHaveBeenCalledOnce();
});
it('a failed authorization cannot become a successful enable while the helper is still exiting', async () => {
  const { child, lid, failed } = fixture();
  const starting = lid.setEnabled(true);
  child.emit('message', { type: 'error', message: 'not authorized' });
  await expect(starting).rejects.toThrow('not authorized');
  await expect(lid.setEnabled(true)).rejects.toThrow('not authorized');
  expect(failed).toHaveBeenCalledWith('not authorized');
  child.emit('exit', 1);
});
it('surfaces an unexpected helper exit after successful activation', async () => {
  const { child, lid, failed } = fixture();
  const starting = lid.setEnabled(true);
  child.emit('message', { type: 'ready' });
  await starting;
  child.emit('exit', 0);
  expect(failed).toHaveBeenCalledWith(expect.stringContaining('意外退出'));
});
