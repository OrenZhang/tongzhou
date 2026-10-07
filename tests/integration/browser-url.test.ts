import { describe, it, expect } from 'vitest';
import { browserUrl, serviceUrl } from '../../electron/services/accounts/connectors';

describe('local development browser', () => {
  it('allows HTTP only on loopback without relaxing account service URLs', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(browserUrl(`http://${host}:3218/products`).pathname).toBe('/products');
      expect(() => serviceUrl(`http://${host}:3218`)).toThrow();
    }
    for (const url of [
      'http://example.com',
      'http://localhost.example.com',
      'http://192.168.1.2',
      'http://user:pass@localhost',
      'file:///C:/x',
      'javascript:alert(1)',
    ])
      expect(() => browserUrl(url)).toThrow();
    expect(browserUrl('https://example.com/path').protocol).toBe('https:');
  });
});
