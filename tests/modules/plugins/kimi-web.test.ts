import { describe, expect, it, vi } from 'vitest';
import { callKimiWeb } from '../../../electron/modules/plugins/kimi-web';

describe('Kimi web MCP adapter', () => {
  const signal = new AbortController().signal;
  it('uses the official search request shape and returns readable sources', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          search_results: [
            {
              title: 'Example',
              url: 'https://example.com',
              snippet: 'Summary',
              content: 'Full text',
            },
          ],
        }),
      ),
    );
    const result = await callKimiWeb(
      'web_search',
      { query: 'test', include_content: true },
      signal,
      'key',
      fetcher,
    );
    expect(fetcher.mock.calls[0][0]).toBe('https://api.kimi.com/coding/v1/search');
    const init = fetcher.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({
      text_query: 'test',
      limit: 5,
      enable_page_crawling: true,
      timeout_seconds: 30,
    });
    expect(init.headers.Authorization).toBe('Bearer key');
    expect(init.redirect).toBe('error');
    expect(result.content[0].text).toContain('https://example.com');
  });
  it('fetches markdown through the provider, without sending the key to the target page', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('# Article'));
    const result = await callKimiWeb(
      'fetch_page',
      { url: 'https://example.com' },
      signal,
      'key',
      fetcher,
    );
    expect(fetcher.mock.calls[0][0]).toBe('https://api.kimi.com/coding/v1/fetch');
    expect(result.content[0].text).toContain('# Article');
  });
  it('rejects missing credentials, invalid arguments and credential-bearing URLs before network access', async () => {
    const fetcher = vi.fn();
    await expect(callKimiWeb('web_search', { query: 'test' }, signal, '', fetcher)).rejects.toThrow(
      'API Key',
    );
    await expect(
      callKimiWeb('web_search', { query: 'test', limit: 100 }, signal, 'key', fetcher),
    ).rejects.toThrow();
    await expect(
      callKimiWeb('fetch_page', { url: 'https://user:pass@example.com' }, signal, 'key', fetcher),
    ).rejects.toThrow('凭据');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds responses and never exposes an error response body', async () => {
    const rejected = vi
      .fn()
      .mockResolvedValue(new Response('secret-key-in-error', { status: 401 }));
    await expect(
      callKimiWeb('web_search', { query: 'test' }, signal, 'key', rejected),
    ).rejects.toThrow('HTTP 401');
    const huge = vi.fn().mockResolvedValue(new Response('x'.repeat(2_000_001)));
    await expect(
      callKimiWeb('fetch_page', { url: 'https://example.com' }, signal, 'key', huge),
    ).rejects.toThrow('过大');
  });
});
