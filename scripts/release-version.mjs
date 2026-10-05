import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Stable release requires a numeric version');
if (
  process.env.GITHUB_REF?.startsWith('refs/tags/') &&
  process.env.GITHUB_REF !== `refs/tags/v${version}`
)
  throw new Error('Release tag must match package.json');
console.log(`Preparing v${version}`);
