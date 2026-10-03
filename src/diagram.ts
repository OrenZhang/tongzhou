import DOMPurify from 'dompurify';
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;
const cache = new Map<string, { url: string; width: number }>();
export function renderDiagram(
  text: string,
  dark: boolean,
): Promise<{ url: string; width: number }> {
  const key = (dark ? 'dark:' : 'light:') + text;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const task = queue.then(async () => {
    if (text.length > 50000) throw new Error('图表过大，请查看源码。');
    // Diagram directives are not application configuration. Keep rendering policy host-owned.
    if (/%%\s*\{|^\s*---\s*\r?\n/.test(text)) throw new Error('请移除图表中的配置指令后查看图形。');
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      look: 'classic',
      theme: dark ? 'dark' : 'neutral',
      maxTextSize: 50000,
      maxEdges: 300,
      fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif',
      secure: [
        'securityLevel',
        'startOnLoad',
        'htmlLabels',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
      ],
    });
    const host = document.createElement('div');
    host.className = 'diagram-render-host';
    document.body.append(host);
    try {
      const result = await mermaid.render('tz-diagram-' + ++counter, text, host);
      const svg = DOMPurify.sanitize(result.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'script', 'image', 'a', 'iframe'],
        FORBID_ATTR: ['href', 'xlink:href'],
      });
      const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const element = document.documentElement;
      const bounds = element
        .getAttribute('viewBox')
        ?.split(/[\s,]+/)
        .map(Number);
      const width = bounds && Number.isFinite(bounds[2]) && bounds[2] > 0 ? bounds[2] : 600;
      if (bounds && bounds[3] > 0) {
        element.setAttribute('width', String(width));
        element.setAttribute('height', String(bounds[3]));
      }
      // Image rendering isolates SVG styles and disables script/event execution.
      const url =
        'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent(new XMLSerializer().serializeToString(element));
      const image = { url, width };
      cache.set(key, image);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
      return image;
    } finally {
      host.remove();
    }
  });
  queue = task.catch(() => {});
  return task;
}
