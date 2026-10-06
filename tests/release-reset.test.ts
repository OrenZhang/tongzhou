import { expect, it, vi } from 'vitest';
import { resetInitialRelease } from '../scripts/reset-initial-release.mjs';

function fixture() {
  const sha = 'a'.repeat(40);
  const assets = [
    'win-x64.exe',
    'mac-arm64.dmg',
    'mac-x64.dmg',
    'mac-arm64.zip',
    'mac-x64.zip',
  ].map((suffix) => `Tongzhou-0.1.0-${suffix}`);
  const release = {
    id: 999,
    target_commitish: sha,
    draft: false,
    prerelease: false,
    assets: [...assets, 'latest.yml', 'latest-mac.yml'].map((name) => ({
      name,
      size: 100,
      state: 'uploaded',
    })),
  };
  let old: unknown = { id: 403915319, tag_name: 'v0.5.8' };
  let tag: unknown = {
    object: { type: 'commit', sha: '9abf7aff14fdf0c77ec9eaac78d675b527e4d976' },
  };
  const api = vi.fn((method: string, endpoint: string) => {
    if (method === 'DELETE') {
      if (endpoint.endsWith('/403915319')) old = undefined;
      else if (endpoint.endsWith('/git/refs/tags/v0.5.8')) tag = undefined;
      else throw new Error('Unexpected deletion');
      return undefined;
    }
    if (endpoint.endsWith('/releases/tags/v0.1.0') || endpoint.endsWith('/releases/latest'))
      return release;
    if (endpoint.endsWith('/403915319')) return old;
    if (endpoint.endsWith('/git/ref/tags/v0.5.8')) return tag;
    throw new Error('Unexpected lookup');
  });
  const args = { version: '0.1.0', repo: 'OrenZhang/tongzhou', sha, api };
  return {
    args,
    release,
    api,
    changeTag: () => {
      tag = { object: { type: 'commit', sha: 'b'.repeat(40) } };
    },
  };
}
it('cleans up only the identified preview after complete current artifacts are public; reruns are safe', () => {
  const { args, api } = fixture();
  resetInitialRelease(args);
  expect(
    api.mock.calls.filter(([method]) => method === 'DELETE').map(([, endpoint]) => endpoint),
  ).toEqual([
    'repos/OrenZhang/tongzhou/releases/403915319',
    'repos/OrenZhang/tongzhou/git/refs/tags/v0.5.8',
  ]);
  resetInitialRelease(args);
  expect(api.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(2);
});
it('does not delete anything for incomplete or unpublished replacements, changed tags, or future versions', () => {
  for (const scenario of ['missing', 'draft', 'sha', 'tag', 'future']) {
    const { args, release, api, changeTag } = fixture();
    if (scenario === 'missing') release.assets.pop();
    if (scenario === 'draft') release.draft = true;
    if (scenario === 'sha') args.sha = 'b'.repeat(40);
    if (scenario === 'tag') changeTag();
    if (scenario === 'future') args.version = '0.2.0';
    if (scenario === 'future') expect(() => resetInitialRelease(args)).not.toThrow();
    else expect(() => resetInitialRelease(args)).toThrow();
    expect(api.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(0);
  }
});
