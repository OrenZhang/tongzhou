export function projectFileReference(
  href: string,
  root: string,
): { path: string; line: number } | undefined {
  if (!href || !root || href.startsWith('#') || href.includes('?')) return;
  let value: string;
  try {
    value = decodeURIComponent(href).replaceAll('\\', '/');
  } catch {
    return;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return;
  const suffix = value.match(/(?:#L|:)(\d+)(?:-L?\d+)?$/);
  const line = suffix ? Math.min(1000000, Number(suffix[1])) : 0;
  if (suffix) value = value.slice(0, -suffix[0].length);
  const base = root.replaceAll('\\', '/').replace(/\/$/, '') + '/';
  if (value.startsWith('/') || /^[a-z]:\//i.test(value)) {
    const windows = /^[a-z]:\//i.test(base);
    if (!(windows ? value.toLowerCase().startsWith(base.toLowerCase()) : value.startsWith(base)))
      return;
    value = value.slice(base.length);
  }
  value = value.replace(/^\.\//, '');
  if (
    !value ||
    /[\x00-\x1f:#]/.test(value) ||
    value.split('/').some((part) => !part || part === '..' || part === '.')
  )
    return;
  return { path: value, line };
}
