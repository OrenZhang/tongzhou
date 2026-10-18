import english from './locales/en.json';

export type AppLocale = 'zh-CN' | 'en';
let locale: AppLocale = 'zh-CN';
const listeners = new Set<() => void>();
export const getLocale = () => locale;
export const subscribeLocale = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function setLocale(value: AppLocale) {
  if (locale === value) return;
  locale = value;
  for (const listener of listeners) listener();
}
/** Translate only application-owned copy. Interpolated user data is never translated. */
export function t(source: string, values: readonly unknown[] = []): string {
  const template =
    locale === 'en' && Object.hasOwn(english, source)
      ? (english as Record<string, string>)[source]
      : source;
  return template.replace(/\{(\d+)\}/g, (match, index) =>
    index in values ? String(values[Number(index)] ?? '') : match,
  );
}
/** Live labels in static UI catalogs; identifiers, keys and stored objects remain unchanged. */
export function localize<T extends object>(source: T): T {
  const cache = new WeakMap<object, object>();
  const wrap = (value: object): object => {
    const previous = cache.get(value);
    if (previous) return previous;
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        const item = Reflect.get(target, key, receiver);
        if (
          typeof item === 'string' &&
          !['id', 'value', 'key', 'type', 'kind', 'path', 'command'].includes(String(key))
        )
          return t(item);
        if (
          item &&
          typeof item === 'object' &&
          (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype)
        )
          return wrap(item);
        return item;
      },
    });
    cache.set(value, proxy);
    return proxy;
  };
  return wrap(source) as T;
}
