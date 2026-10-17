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
    const colors = dark
      ? {
          canvas: '#1e2128',
          node: '#27364a',
          secondary: '#2d3947',
          text: '#e2ebf7',
          border: '#526a89',
          line: '#9aaec8',
          group: '#222a36',
          groupBorder: '#3d4a5d',
        }
      : {
          canvas: '#ffffff',
          node: '#edf4ff',
          secondary: '#f1f6fc',
          text: '#263a54',
          border: '#b7cbe5',
          line: '#7c8fa9',
          group: '#f8fafd',
          groupBorder: '#dce5f0',
        };
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      look: 'classic',
      theme: 'base',
      themeVariables: {
        darkMode: dark,
        background: colors.canvas,
        primaryColor: colors.node,
        primaryTextColor: colors.text,
        primaryBorderColor: colors.border,
        secondaryColor: colors.secondary,
        secondaryTextColor: colors.text,
        secondaryBorderColor: colors.border,
        tertiaryColor: colors.group,
        tertiaryTextColor: colors.text,
        tertiaryBorderColor: colors.groupBorder,
        lineColor: colors.line,
        arrowheadColor: colors.line,
        clusterBkg: colors.group,
        clusterBorder: colors.groupBorder,
        edgeLabelBackground: 'transparent',
        noteBkgColor: colors.secondary,
        noteTextColor: colors.text,
        noteBorderColor: colors.border,
        gridColor: colors.groupBorder,
        altSectionBkgColor: colors.canvas,
        doneTaskBkgColor: colors.secondary,
        doneTaskBorderColor: colors.border,
      },
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
      // Keep the image canvas consistent with its surrounding page in every app style.
      element.style.backgroundColor = 'transparent';
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
