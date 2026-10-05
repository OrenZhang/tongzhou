import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Stable release requires a numeric version');
if (
  process.env.GITHUB_REF?.startsWith('refs/tags/') &&
  process.env.GITHUB_REF !== `refs/tags/v${version}`
)
  throw new Error('Release tag must match package.json');
const event = process.env.GITHUB_EVENT_NAME;
const ref = process.env.GITHUB_REF;
if (event) {
  if (!['push', 'workflow_dispatch'].includes(event)) throw new Error('Unsupported release event');
  if (event === 'workflow_dispatch' && ref !== 'refs/heads/release')
    throw new Error('Manual publishing must select the release branch');
  if (ref !== 'refs/heads/release' && !ref?.startsWith('refs/tags/v'))
    throw new Error('Publishing requires the release branch or a version tag');
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/release'], {
      stdio: 'pipe',
    });
  } catch {
    throw new Error('The tagged or selected commit must already be merged into origin/release');
  }
}
console.log(`Preparing v${version}`);
