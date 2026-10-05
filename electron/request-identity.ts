import { version } from '../package.json';

export const clientIdentity = { name: 'tongzhou', title: '同舟 Tongzhou', version };
export const userAgent = `Tongzhou/${version}`;

/** Keep transport, auth and Request semantics intact while branding app-owned HTTP traffic. */
export function withRequestIdentity(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  compatibility?: 'clash.meta',
): RequestInit {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  // Subscription servers use this token to select the Clash configuration format.
  headers.set('User-Agent', compatibility ? `${userAgent} ${compatibility}` : userAgent);
  return { ...init, headers };
}

export const appFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, withRequestIdentity(input, init));
