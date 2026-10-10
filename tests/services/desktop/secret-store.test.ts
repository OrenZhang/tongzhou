import { expect, it } from 'vitest';
import { linuxPasswordStore } from '../../../electron/services/desktop/secret-store';

it('defaults to the Secret Service backend when Linux has no desktop identity (WSL)', () => {
  expect(linuxPasswordStore('linux', {}, ['electron', '.'])).toBe('gnome-libsecret');
});
it('leaves real desktop sessions to Chromium auto-detection', () => {
  expect(linuxPasswordStore('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }, [])).toBeUndefined();
  expect(linuxPasswordStore('linux', { XDG_SESSION_DESKTOP: 'KDE' }, [])).toBeUndefined();
  expect(linuxPasswordStore('linux', { XDG_CURRENT_DESKTOP: '' }, [])).toBe('gnome-libsecret');
});
it('never overrides an explicit user flag', () => {
  expect(linuxPasswordStore('linux', {}, ['.', '--password-store=kwallet6'])).toBeUndefined();
});
it('does nothing on other platforms', () => {
  expect(linuxPasswordStore('darwin', {}, [])).toBeUndefined();
  expect(linuxPasswordStore('win32', {}, [])).toBeUndefined();
});
