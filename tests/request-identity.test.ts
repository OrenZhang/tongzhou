import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { version } from '../package.json';
import { appFetch, userAgent, withRequestIdentity } from '../electron/request-identity';
import { serviceFetch, setServiceTransport } from '../electron/service-network';
import { listModels } from '../electron/providers';
import type { Provider } from '../src/shared/types';

afterEach(() => {
  setServiceTransport();
  vi.restoreAllMocks();
});

it.each([
  { 'user-agent': 'OpenAI/JS fixture', Authorization: 'Bearer fixture' },
  new Headers({ 'User-Agent': 'OpenAI/JS fixture', Authorization: 'Bearer fixture' }),
  [
    ['USER-AGENT', 'OpenAI/JS fixture'],
    ['Authorization', 'Bearer fixture'],
  ],
] as HeadersInit[])(
  'replaces SDK identity without dropping auth or changing caller headers',
  (headers) => {
    const before = [...new Headers(headers)];
    const signal = new AbortController().signal;
    const result = withRequestIdentity('https://example.com', {
      headers,
      method: 'POST',
      body: 'fixture',
      signal,
      redirect: 'error',
    });
    expect([...new Headers(headers)]).toEqual(before);
    expect(new Headers(result.headers).get('user-agent')).toBe(`Tongzhou/${version}`);
    expect(new Headers(result.headers).get('authorization')).toBe('Bearer fixture');
    expect(result).toMatchObject({ method: 'POST', body: 'fixture', signal, redirect: 'error' });
  },
);

it('uses the selected service transport and retains the subscription format token', async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response('{}'));
  setServiceTransport(transport);
  await serviceFetch('https://example.com/token', { credentials: 'include' });
  await serviceFetch('https://example.com/subscription', { redirect: 'error' }, 'clash.meta');
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0][1]?.credentials).toBe('omit');
  expect(new Headers(transport.mock.calls[0][1]?.headers).get('user-agent')).toBe(userAgent);
  expect(new Headers(transport.mock.calls[1][1]?.headers).get('user-agent')).toBe(
    `${userAgent} clash.meta`,
  );
  expect(transport.mock.calls[1][1]?.redirect).toBe('error');
});

it('sends the identity on the wire for Request inputs and model discovery', async () => {
  const received: { url?: string; ua?: string; auth?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({
      url: req.url,
      ua: req.headers['user-agent'],
      auth: req.headers.authorization,
      body,
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = new Request(baseUrl + '/request', {
      method: 'POST',
      body: 'kept',
      headers: { Authorization: 'Bearer request', 'User-Agent': 'OpenAI/JS fixture' },
    });
    await (await appFetch(request)).text();
    await (await serviceFetch(baseUrl + '/service')).text();
    const provider: Provider = {
      id: 'fixture',
      name: 'fixture',
      protocol: 'openai-chat',
      auth: 'bearer',
      baseUrl,
      models: [],
      contextChars: 10000,
      maxOutputTokens: 1024,
    };
    expect(await listModels(provider, 'key')).toEqual(['fixture-model']);
    expect(received).toEqual([
      { url: '/request', ua: userAgent, auth: 'Bearer request', body: 'kept' },
      { url: '/service', ua: userAgent, auth: undefined, body: '' },
      { url: '/models', ua: userAgent, auth: 'Bearer key', body: '' },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
