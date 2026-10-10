import { expect, it } from 'vitest';
import { linuxOzoneArgs } from '../../../scripts/linux-ozone-args.mjs';

it('pins Linux launches to XWayland so computer control can reach windows', () => {
  expect(linuxOzoneArgs('linux', {}, ['node', 'start.mjs'])).toEqual(['--ozone-platform=x11']);
});
it('respects an explicit platform flag or env hint', () => {
  expect(linuxOzoneArgs('linux', {}, ['.', '--ozone-platform=wayland'])).toEqual([]);
  expect(linuxOzoneArgs('linux', { ELECTRON_OZONE_PLATFORM_HINT: 'auto' }, [])).toEqual([]);
});
it('does nothing on other platforms', () => {
  expect(linuxOzoneArgs('darwin', {}, [])).toEqual([]);
  expect(linuxOzoneArgs('win32', {}, [])).toEqual([]);
});
