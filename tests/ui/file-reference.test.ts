import { describe, expect, it } from 'vitest';
import { projectFileReference } from '../../src/shared/file-reference';
describe('project file references', () => {
  it('opens relative and matching absolute paths with line numbers', () => {
    expect(projectFileReference('src/main.ts#L12', 'C:\\work\\app')).toEqual({
      path: 'src/main.ts',
      line: 12,
    });
    expect(projectFileReference('c:/work/app/src/main.ts:8', 'C:\\work\\app')).toEqual({
      path: 'src/main.ts',
      line: 8,
    });
    expect(projectFileReference('/work/app/a%20b.ts', '/work/app')).toEqual({
      path: 'a b.ts',
      line: 0,
    });
  });
  it('resolves document links from the current file without leaving the project', () => {
    expect(projectFileReference('./guide.md', '/work/app', 'docs/README.md')).toEqual({
      path: 'docs/guide.md',
      line: 0,
    });
    expect(projectFileReference('../src/main.ts#L12', '/work/app', 'docs/README.md')).toEqual({
      path: 'src/main.ts',
      line: 12,
    });
    expect(projectFileReference('/work/app/README.md', '/work/app', 'docs/README.md')).toEqual({
      path: 'README.md',
      line: 0,
    });
    expect(projectFileReference('./guide.md', 'C:\\work\\app', 'docs\\README.md')).toEqual({
      path: 'docs/guide.md',
      line: 0,
    });
    for (const link of [
      '../../outside.md',
      '%2e%2e/%2e%2e/outside.md',
      '/work/elsewhere/a.md',
      'javascript:alert(1)',
    ])
      expect(projectFileReference(link, '/work/app', 'docs/README.md')).toBeUndefined();
  });
  it('rejects external roots, traversal, schemes and malformed encodings', () => {
    for (const value of [
      'C:/work/app-other/a.ts',
      '../a.ts',
      '%2e%2e/a',
      'https://example.com/x',
      'javascript:alert(1)',
      '//host/x',
      '#hello',
      'a%XX',
      'src/a:ads',
    ])
      expect(projectFileReference(value, 'C:/work/app')).toBeUndefined();
    expect(projectFileReference('/work/App/a', '/work/app')).toBeUndefined();
  });
});
