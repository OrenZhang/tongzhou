import { withRequestIdentity } from './request-identity';

// The desktop installs Chromium's isolated session fetch after app.ready so OAuth
// and MCP use the same system proxy settings as the user's browser.
let transport: typeof fetch | undefined;
export function setServiceTransport(value?: typeof fetch) {
  transport = value;
}
export function serviceFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  compatibility?: 'clash.meta',
) {
  return (transport ?? globalThis.fetch)(input, {
    ...withRequestIdentity(input, init, compatibility),
    credentials: 'omit',
  });
}
