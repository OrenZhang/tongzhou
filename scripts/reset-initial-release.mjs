import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// One-time, user-requested transition from the development preview to v0.1.0.
// Never enumerate/delete arbitrary releases or rewrite source history.
const repository = 'OrenZhang/tongzhou';
const preview = { id: 403915319, tag: 'v0.5.8', sha: '9abf7aff14fdf0c77ec9eaac78d675b527e4d976' };
export function resetInitialRelease({ version, repo, sha, api }) {
  if (version !== '0.1.0') return;
  if (repo !== repository || !/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new Error('Unexpected release reset context');
  const base = `repos/${repository}`;
  const release = api('GET', `${base}/releases/tags/v0.1.0`);
  const latest = api('GET', `${base}/releases/latest`);
  if (
    !release ||
    release.draft ||
    release.prerelease ||
    release.target_commitish !== sha ||
    latest?.id !== release.id
  )
    throw new Error('Publish this commit as the stable latest v0.1.0 before retiring the preview');
  for (const name of [
    'Tongzhou-0.1.0-win-x64.exe',
    'Tongzhou-0.1.0-mac-arm64.dmg',
    'Tongzhou-0.1.0-mac-x64.dmg',
    'Tongzhou-0.1.0-mac-arm64.zip',
    'Tongzhou-0.1.0-mac-x64.zip',
    'latest.yml',
    'latest-mac.yml',
  ])
    if (!release.assets?.some((a) => a.name === name && a.size > 0 && a.state === 'uploaded'))
      throw new Error('Missing verified v0.1.0 release asset: ' + name);
  const old = api('GET', `${base}/releases/${preview.id}`, true);
  const tag = api('GET', `${base}/git/ref/tags/${preview.tag}`, true);
  if (old && (old.id !== preview.id || old.tag_name !== preview.tag))
    throw new Error('Preview release identity changed');
  if (tag && (tag.object?.type !== 'commit' || tag.object.sha !== preview.sha))
    throw new Error('Preview tag identity changed');
  if (old) api('DELETE', `${base}/releases/${preview.id}`);
  if (tag) api('DELETE', `${base}/git/refs/tags/${preview.tag}`);
  if (
    api('GET', `${base}/releases/${preview.id}`, true) ||
    api('GET', `${base}/git/ref/tags/${preview.tag}`, true)
  )
    throw new Error('Preview cleanup could not be verified');
  console.log(
    'v0.1.0 verified; retired the v0.5.8 development release and tag. Git history retained.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  resetInitialRelease({
    version,
    repo: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    api(method, endpoint, missing = false) {
      try {
        const output = execFileSync('gh', ['api', '--method', method, endpoint], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return output.trim() ? JSON.parse(output) : undefined;
      } catch (error) {
        if (missing && String(error.stderr).includes('(HTTP 404)')) return undefined;
        throw error;
      }
    },
  });
}
