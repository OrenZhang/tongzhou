import { afterEach, expect, it, vi } from 'vitest';
import { fetchCanvasText, checkedNodeText } from '../../../electron/modules/canvas/text-source';

afterEach(() => vi.restoreAllMocks());
it('loads source text without executing it, follows redirects and omits credentials', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/page.html' } }))
    .mockResolvedValueOnce(
      new Response('<h1>同舟</h1><script>bad()</script>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
  expect(await fetchCanvasText('https://example.com/start', fetcher)).toEqual({
    text: '<h1>同舟</h1><script>bad()</script>',
    url: 'https://example.com/page.html',
  });
  expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
});
it('rejects non-web URLs, credentials, invalid redirects, failed responses and binary resources', async () => {
  const fetcher = vi.fn();
  for (const url of ['file:///secret', 'https://user:password@example.com'])
    await expect(fetchCanvasText(url, fetcher)).rejects.toThrow('HTTP');
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: 'file:///secret' } }),
  );
  await expect(fetchCanvasText('https://example.com', fetcher)).rejects.toThrow('HTTP');
  fetcher.mockResolvedValueOnce(new Response('missing', { status: 404 }));
  await expect(fetchCanvasText('https://example.com', fetcher)).rejects.toThrow('404');
  fetcher.mockResolvedValueOnce(
    new Response('image', { headers: { 'content-type': 'image/png' } }),
  );
  await expect(fetchCanvasText('https://example.com', fetcher)).rejects.toThrow('文本文件');
  expect(() => checkedNodeText('a\0b')).toThrow('文本资源');
});
it('does not silently truncate source, including when content length is absent', async () => {
  for (const size of [32001, 128001]) {
    const fetcher = vi.fn().mockResolvedValue(new Response('a'.repeat(size)));
    await expect(fetchCanvasText('https://example.com/source.txt', fetcher)).rejects.toThrow(
      '32,000',
    );
  }
  expect(checkedNodeText('a'.repeat(32000))).toHaveLength(32000);
});
