import { serviceFetch } from '../../services/network/service-network';

export const MAX_NODE_TEXT = 32000;
export function checkedNodeText(text: string) {
  if (text.includes('\0')) throw new Error('请选择 HTML、SVG、Markdown 或其他文本资源');
  if (text.length > MAX_NODE_TEXT) throw new Error('节点正文最多 32,000 字符，请精简内容后再导入');
  return text;
}

/** Fetch an explicit user-supplied source without credentials or executing its contents. */
export async function fetchCanvasText(address: string, fetcher = serviceFetch) {
  const validate = (value: string) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('请输入不含账号密码的 HTTP 或 HTTPS 地址');
    return url;
  };
  let url = validate(address);
  const signal = AbortSignal.timeout(30000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url.href, { redirect: 'manual', signal, credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('外部地址重定向过多或无效');
      url = validate(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('读取外部地址失败，HTTP ' + response.status);
    }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (
      mime &&
      !/^text\//.test(mime) &&
      ![
        'image/svg+xml',
        'application/json',
        'application/xml',
        'application/xhtml+xml',
        'application/octet-stream',
      ].includes(mime)
    ) {
      await response.body.cancel();
      throw new Error('外部地址需指向 HTML、SVG、Markdown 或其他文本文件');
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_NODE_TEXT * 4)
          throw new Error('节点正文最多 32,000 字符，请精简内容后再导入');
        parts.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const charset =
      /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ??
      'utf-8';
    const text = checkedNodeText(
      new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(parts)),
    );
    return { text, url: url.href };
  }
  throw new Error('外部地址重定向过多或无效');
}
