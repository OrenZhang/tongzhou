import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'OrenZhang/tongzhou';
const original = 'eb460571e55be3f271b7fc068a33cced81c8a42f';
const releaseId = 404233503;
export const initialAssetNames = [
  ...['win-x64.exe', 'mac-arm64.dmg', 'mac-x64.dmg', 'mac-arm64.zip', 'mac-x64.zip'].flatMap(
    (suffix) => [`Tongzhou-0.1.0-${suffix}`, `Tongzhou-0.1.0-${suffix}.blockmap`],
  ),
  'latest.yml',
  'latest-mac.yml',
  'SHA256SUMS-win32-x64.txt',
  'SHA256SUMS-darwin-arm64.txt',
  'SHA256SUMS-darwin-x64.txt',
];

// A narrowly scoped exception requested for the initial version. Future commits cannot
// replace a different release/tag head without another explicit change to this guard.
export function replaceInitialRelease({ version, repo, sha, assets, notes, api, upload }) {
  if (
    version !== '0.1.0' ||
    repo !== repository ||
    !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    sha === original
  )
    throw new Error('Unexpected initial-release replacement context');
  if (
    assets.length !== initialAssetNames.length ||
    new Set(assets.map((a) => a.name)).size !== assets.length ||
    initialAssetNames.some(
      (name) =>
        !assets.some((a) => a.name === name && a.size > 0 && /^[a-f0-9]{64}$/.test(a.sha256)),
    )
  )
    throw new Error('Incomplete initial-release artifacts');
  const base = `repos/${repo}`;
  const releasePath = `${base}/releases/${releaseId}`;
  const tagPath = `${base}/git/ref/tags/v0.1.0`;
  const release = api('GET', releasePath);
  const tag = api('GET', tagPath);
  const releases = api('GET', `${base}/releases?per_page=100`);
  if (
    release.id !== releaseId ||
    release.tag_name !== 'v0.1.0' ||
    release.immutable ||
    release.prerelease ||
    ![original, sha].includes(release.target_commitish) ||
    tag.object?.type !== 'commit' ||
    ![original, sha].includes(tag.object.sha) ||
    releases.some((r) => r.id !== releaseId)
  )
    throw new Error('Initial release or tag changed; refusing to replace it');
  if (api('GET', `${base}/branches/release`).commit?.sha !== sha)
    throw new Error('Only the current release branch can be published');
  const verifyAssets = (current) => {
    if (
      current.assets?.length !== assets.length ||
      assets.some(
        (a) =>
          !current.assets.some(
            (remote) =>
              remote.name === a.name &&
              remote.state === 'uploaded' &&
              remote.size === a.size &&
              remote.digest === `sha256:${a.sha256}`,
          ),
      )
    )
      throw new Error('Uploaded release artifacts do not match local SHA-256 digests');
  };
  // Keep the same release ID and URL. Draft visibility prevents a partially replaced
  // package set from being offered by the updater; a failed upload remains retryable.
  api('PATCH', releasePath, {
    draft: true,
    target_commitish: sha,
    name: '同舟 v0.1.0',
    body: notes,
  });
  upload();
  verifyAssets(api('GET', releasePath));
  const latestTag = api('GET', tagPath);
  if (latestTag.object?.type !== 'commit' || ![original, sha].includes(latestTag.object.sha))
    throw new Error('Tag changed during upload');
  if (latestTag.object.sha !== sha)
    api('PATCH', `${base}/git/refs/tags/v0.1.0`, { sha, force: true });
  api('PATCH', releasePath, {
    draft: false,
    prerelease: false,
    make_latest: 'true',
    target_commitish: sha,
  });
  const published = api('GET', `${base}/releases/latest`);
  verifyAssets(published);
  if (
    published.id !== releaseId ||
    published.draft ||
    published.target_commitish !== sha ||
    api('GET', tagPath).object?.sha !== sha ||
    api('GET', `${base}/releases?per_page=100`).length !== 1
  )
    throw new Error('Final release verification failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const files = await readdir('release-assets');
  const assets = await Promise.all(
    files.map(async (name) => {
      const file = `release-assets/${name}`,
        hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      return { name, size: (await stat(file)).size, sha256: hash.digest('hex') };
    }),
  );
  replaceInitialRelease({
    version,
    repo: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    assets,
    notes: await readFile('docs/RELEASE_NOTES.md', 'utf8'),
    api(method, endpoint, body) {
      const args = ['api', '--method', method, endpoint];
      if (body) args.push('--input', '-');
      const value = execFileSync('gh', args, {
        input: body ? JSON.stringify(body) : undefined,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return value.trim() ? JSON.parse(value) : undefined;
    },
    upload() {
      execFileSync(
        'gh',
        [
          'release',
          'upload',
          'v0.1.0',
          ...files.map((name) => `release-assets/${name}`),
          '--clobber',
          '--repo',
          repository,
        ],
        { stdio: 'inherit' },
      );
    },
  });
  console.log('Verified updated v0.1.0 packages, tag and sole public release.');
}
