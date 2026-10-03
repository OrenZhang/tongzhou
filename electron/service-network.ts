// The desktop installs Chromium's isolated session fetch after app.ready so OAuth
// and MCP use the same system proxy settings as the user's browser.
let transport: typeof fetch | undefined;
export function setServiceTransport(value?: typeof fetch) {
  transport = value;
}
export const serviceFetch: typeof fetch = (input, init) =>
  (transport ?? globalThis.fetch)(input, { ...init, credentials: 'omit' });
