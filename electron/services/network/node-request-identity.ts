import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { requestUserAgent, withRequestIdentity } from './request-identity';

// Loaded before SDKs in the app and its managed Node engines. Do not use
// NODE_OPTIONS: project commands and external plugin processes must not inherit it.
// Node's fork() inherits execArgv too; remove only this preload after it has loaded.
for (let i = process.execArgv.length - 2; i >= 0; i--)
  if (process.execArgv[i] === '--require' && process.execArgv[i + 1] === __filename)
    process.execArgv.splice(i, 2);
const installed = Symbol.for('tongzhou.request-identity');
const runtime = globalThis as typeof globalThis & { [installed]?: boolean };
if (!runtime[installed]) {
  runtime[installed] = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => originalFetch(input, withRequestIdentity(input, init));
  for (const transport of [http, https]) {
    const originalRequest = transport.request;
    transport.request = ((...args: Parameters<typeof http.request>) => {
      const request = Reflect.apply(originalRequest, transport, args) as http.ClientRequest;
      request.setHeader(
        'User-Agent',
        requestUserAgent(String(request.getHeader('User-Agent') ?? '')),
      );
      return request;
    }) as typeof http.request;
    transport.get = ((...args: Parameters<typeof http.get>) => {
      const request = Reflect.apply(transport.request, transport, args) as http.ClientRequest;
      request.end();
      return request;
    }) as typeof http.get;
  }
  syncBuiltinESMExports();
}
