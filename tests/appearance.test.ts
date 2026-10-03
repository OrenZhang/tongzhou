import { expect, it } from 'vitest';
import { defaultAppearance, normalizeAppearance } from '../src/shared/appearance';
import { projectFamilyId } from '../src/shared/projects';
import type { Project } from '../src/shared/types';

it('migrates an existing theme without inventing stored preferences', () => {
  expect(normalizeAppearance(null, 'dark')).toEqual({ ...defaultAppearance, theme: 'dark' });
  expect(normalizeAppearance({ style: 'sand', font: 'serif', textSize: 18 }, 'light')).toEqual({
    style: 'sand',
    font: 'serif',
    textSize: 18,
    theme: 'light',
  });
});
it('rejects unsupported saved appearance values and keeps explicit system mode', () => {
  expect(
    normalizeAppearance(
      { theme: 'system', style: 'unknown', font: 'url(invalid)', textSize: 300 },
      'dark',
    ),
  ).toEqual(defaultAppearance);
  expect(normalizeAppearance('invalid')).toEqual(defaultAppearance);
});
const project = (id: string, sourceProjectId?: string): Project => ({
  id,
  sourceProjectId,
  name: id,
  path: '/' + id,
  createdAt: 1,
});
it('groups execution workspaces under the original project without changing their IDs', () => {
  const projects = [project('root'), project('work', 'root'), project('nested', 'work')];
  expect(projectFamilyId(projects, 'nested')).toBe('root');
  expect(projectFamilyId(projects, 'work')).toBe('root');
  expect(projectFamilyId(projects, null)).toBeUndefined();
  expect(projects[2].sourceProjectId).toBe('work');
});
it('keeps orphaned projects visible and terminates invalid ownership cycles', () => {
  expect(projectFamilyId([project('orphan', 'missing')], 'orphan')).toBe('orphan');
  expect(projectFamilyId([project('a', 'b'), project('b', 'a')], 'a')).toBe('a');
});
