import { afterEach, expect, it } from 'vitest';
import { getLocale, localize, setLocale, subscribeLocale, t } from '../../src/shared/i18n';
import { normalizeAppearance } from '../../src/shared/appearance';
import { providerLabel } from '../../src/shared/provider-label';
import english from '../../src/shared/locales/en.json';
import { uiCanvasPorts } from '../../src/features/canvas/port-labels';

afterEach(() => setLocale('zh-CN'));

it('switches existing catalog labels live without changing their source or identifiers', () => {
  const source = [{ id: '设置', value: '设置', label: '设置', nested: { title: '画布' } }];
  const labels = localize(source);
  expect(labels[0].label).toBe('设置');
  setLocale('en');
  expect(labels[0].label).toBe('Settings');
  expect(labels[0].nested.title).toBe('Canvas');
  expect(labels[0].id).toBe('设置');
  expect(labels[0].value).toBe('设置');
  expect(source[0].label).toBe('设置');
  setLocale('zh-CN');
  expect(labels[0].label).toBe('设置');
});

it('notifies subscribed views only on a language change and supports unsubscribe', () => {
  let count = 0;
  const off = subscribeLocale(() => count++);
  setLocale('en');
  setLocale('en');
  expect(getLocale()).toBe('en');
  expect(count).toBe(1);
  off();
  setLocale('zh-CN');
  expect(count).toBe(1);
});

it('preserves interpolated user content and falls back for unknown copy', () => {
  setLocale('en');
  expect(t('{0} 账号授权', ['设置 {1}'])).toBe('设置 {1} account authorization');
  expect(t('Unregistered copy')).toBe('Unregistered copy');
  expect(t('constructor')).toBe('constructor');
  expect(t('toString')).toBe('toString');
  expect(t('{0} 账号授权')).toBe('{0} account authorization');
});

it('preserves custom split output names while localizing built-in canvas ports', () => {
  setLocale('en');
  const node = {
    id: 'split',
    kind: 'plugin' as const,
    pluginId: 'content.split',
    title: '设置',
    x: 0,
    y: 0,
  };
  expect(uiCanvasPorts(node).outputs[0].label).toBe('Characters');
  expect(
    uiCanvasPorts({
      ...node,
      config: { categories: [{ id: 'custom', label: '设置', instruction: '用户原文' }] },
    }).outputs[0].label,
  ).toBe('设置');
});

it('keeps every translated placeholder exactly aligned with its source', () => {
  const slots = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort();
  for (const [source, translated] of Object.entries(english)) {
    expect(translated.trim(), source).not.toBe('');
    expect(slots(translated), source).toEqual(slots(source));
  }
});

it('persists supported language preferences without breaking older profiles', () => {
  expect(normalizeAppearance({ language: 'en', theme: 'dark' })).toMatchObject({
    language: 'en',
    theme: 'dark',
  });
  expect(normalizeAppearance({ language: 'zh-CN' }).language).toBe('zh-CN');
  expect(normalizeAppearance({ language: 'unknown' }).language).toBeUndefined();
  expect(normalizeAppearance({ theme: 'light' }).language).toBeUndefined();
});

it('translates built-in connection labels while preserving custom names', () => {
  setLocale('en');
  expect(providerLabel({ id: 'local', name: '本地模型' })).toBe('Local models');
  expect(providerLabel({ id: 'custom', name: '本地模型' })).toBe('本地模型');
  expect(providerLabel({ id: 'local', name: '设置' })).toBe('设置');
});
