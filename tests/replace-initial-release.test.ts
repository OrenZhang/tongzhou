import { describe, expect, it } from 'vitest';
import { initialAssetNames, replaceInitialRelease } from '../scripts/replace-initial-release.mjs';

function fixture() {
  const original = 'eb460571e55be3f271b7fc068a33cced81c8a42f';
  const sha = 'a'.repeat(40);
  const release = {
    id: 404233503,
    tag_name: 'v0.1.0',
    target_commitish: original,
    draft: false,
    prerelease: false,
    immutable: false,
    assets: [] as any[],
  };
  const tag = { object: { type: 'commit', sha: original } };
  const writes: string[] = [];
  const assets = initialAssetNames.map((name) => ({ name, size: 42, sha256: 'b'.repeat(64) }));
  const options = {
    version: '0.1.0',
    repo: 'OrenZhang/tongzhou',
    sha,
    assets,
    notes: 'Updated',
    api(method: string, endpoint: string, body?: Record<string, unknown>): any {
      if (method === 'PATCH') {
        writes.push(endpoint);
        if (endpoint.includes('/git/refs/')) Object.assign(tag.object, body);
        else Object.assign(release, body);
        return {};
      }
      if (endpoint.includes('/git/ref/')) return tag;
      if (endpoint.endsWith('/branches/release')) return { commit: { sha } };
      if (endpoint.includes('?')) return [release];
      return release;
    },
    upload() {
      expect(release.draft).toBe(true);
      expect(tag.object.sha).toBe(original);
      release.assets = assets.map((a) => ({
        ...a,
        state: 'uploaded',
        digest: `sha256:${a.sha256}`,
      }));
    },
  };
  return { options, release, tag, writes, original };
}

describe('initial release package replacement', () => {
  it('uploads and checks all packages before moving the tag and publishing the same release', () => {
    const f = fixture();
    replaceInitialRelease(f.options);
    expect(f.release.id).toBe(404233503);
    expect(f.release.draft).toBe(false);
    expect(f.tag.object.sha).toBe(f.options.sha);
    expect(f.writes).toHaveLength(3);
  });
  it.each(['version', 'repo', 'sha'] as const)(
    'rejects an unexpected %s before any mutation',
    (field) => {
      const f = fixture();
      f.options[field] = 'unexpected';
      expect(() => replaceInitialRelease(f.options)).toThrow('context');
      expect(f.writes).toEqual([]);
    },
  );
  it('rejects missing packages and changed remote heads before any mutation', () => {
    const f = fixture();
    f.options.assets.pop();
    expect(() => replaceInitialRelease(f.options)).toThrow('artifacts');
    expect(f.writes).toEqual([]);
    const g = fixture();
    g.tag.object.sha = 'c'.repeat(40);
    expect(() => replaceInitialRelease(g.options)).toThrow('changed');
    expect(g.writes).toEqual([]);
  });
  it('leaves the release draft and tag unchanged if upload fails', () => {
    const f = fixture();
    f.options.upload = () => {
      throw new Error('network interrupted');
    };
    expect(() => replaceInitialRelease(f.options)).toThrow('network interrupted');
    expect(f.release.draft).toBe(true);
    expect(f.tag.object.sha).toBe(f.original);
  });
  it('refuses to publish artifacts with wrong digests', () => {
    const f = fixture(),
      upload = f.options.upload;
    f.options.upload = () => {
      upload();
      f.release.assets[0].digest = 'sha256:wrong';
    };
    expect(() => replaceInitialRelease(f.options)).toThrow('digests');
    expect(f.release.draft).toBe(true);
    expect(f.tag.object.sha).toBe(f.original);
  });
  it('supports retrying the same commit after the tag was already moved', () => {
    const f = fixture();
    f.release.draft = true;
    f.release.target_commitish = f.options.sha;
    f.tag.object.sha = f.options.sha;
    f.options.upload = () => {
      f.release.assets = f.options.assets.map((a) => ({
        ...a,
        state: 'uploaded',
        digest: `sha256:${a.sha256}`,
      }));
    };
    replaceInitialRelease(f.options);
    expect(f.release.draft).toBe(false);
    expect(f.writes).toHaveLength(2);
  });
});
