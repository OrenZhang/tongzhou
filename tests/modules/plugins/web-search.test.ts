import { describe, expect, it, vi } from 'vitest';
import { parseSearchResults, searchWeb } from '../../../electron/modules/plugins/web-search';

const rss = (items: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
const item = (title: string, link: string, description = '') =>
  `<item><title>${title}</title><link>${link}</link><description>${description}</description></item>`;
const signal = new AbortController().signal;

describe('default keyword search without provider credentials', () => {
  it('returns titles, safe original URLs and readable snippets, deduplicated and limited', () => {
    const xml = rss(
      item(
        'A &amp; B',
        'https://example.com/?a=1&amp;b=2',
        '<![CDATA[<b>hello</b> &#x4e2d;&#25991;]]>',
      ) +
        item('duplicate', 'https://example.com/?a=1&amp;b=2') +
        item('unsafe', 'javascript:alert(1)') +
        item('private', 'https://user:pass@example.com') +
        item('second', 'https://example.org') +
        item('third', 'https://third.example'),
    );
    expect(parseSearchResults(xml, 2)).toEqual([
      { title: 'A & B', url: 'https://example.com/?a=1&b=2', snippet: 'hello 中文' },
      { title: 'second', url: 'https://example.org/', snippet: '' },
    ]);
  });
  it('distinguishes empty results from verification pages and malformed responses', () => {
    expect(parseSearchResults(rss(''), 5)).toEqual([]);
    for (const xml of [
      '<html>captcha</html>',
      '<rss><channel>',
      '<!DOCTYPE rss>' + rss(''),
      rss(item('bad', 'javascript:bad')),
    ]) {
      expect(() => parseSearchResults(xml, 5)).toThrow();
    }
  });
  it('supports the mainland redirect, preserving Unicode query and sending no credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cn.bing.com/search?format=rss&q=%E7%8C%AB' },
        }),
      )
      .mockResolvedValueOnce(new Response(rss(item('猫', 'https://example.com/cat'))));
    const result = await searchWeb({ query: '猫', limit: 1 }, signal, fetcher);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('q')).toBe('猫');
    expect(new URL(String(fetcher.mock.calls[1][0])).hostname).toBe('cn.bing.com');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'manual' });
    expect(new Headers(fetcher.mock.calls[0][1].headers).has('Authorization')).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      source: 'Bing',
      results: [{ title: '猫', url: 'https://example.com/cat' }],
    });
  });
  it('refuses redirects outside the search service', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
      );
    await expect(searchWeb({ query: 'test' }, signal, fetcher)).rejects.toThrow('非预期跳转');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid input and respects cancellation before network access', async () => {
    const fetcher = vi.fn();
    for (const args of [
      { query: '' },
      { query: 'q', limit: 50 },
      { query: 'q', url: 'https://other.example' },
    ])
      await expect(searchWeb(args, signal, fetcher)).rejects.toThrow('关键词');
    await expect(searchWeb({ query: 'q' }, AbortSignal.abort(), fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports service and network failures rather than returning false no-results', async () => {
    await expect(
      searchWeb(
        { query: 'q' },
        signal,
        vi.fn().mockResolvedValue(new Response('private diagnostics', { status: 429 })),
      ),
    ).rejects.toThrow('HTTP 429');
    await expect(
      searchWeb(
        { query: 'q' },
        signal,
        vi.fn().mockRejectedValue(new Error('internal connection details')),
      ),
    ).rejects.toThrow('默认搜索暂不可用');
    await expect(
      searchWeb(
        { query: 'q' },
        signal,
        vi.fn().mockResolvedValue(new Response('x'.repeat(1_000_001))),
      ),
    ).rejects.toThrow('响应过大');
  });
});
