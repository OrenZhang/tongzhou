import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('release-assets', { recursive: true });
const mac = [];
const names = new Set();
for (const dir of await readdir('artifacts')) {
  for (const name of await readdir(path.join('artifacts', dir))) {
    const file = path.join('artifacts', dir, name);
    if (name.endsWith('.yml')) {
      const meta = YAML.parse(await readFile(file, 'utf8'));
      if (meta.version !== version) throw new Error('Artifact version mismatch');
      for (const item of meta.files ?? []) {
        if (path.basename(item.url) !== item.url) throw new Error('Invalid artifact path');
        const hash = createHash('sha512');
        for await (const chunk of createReadStream(path.join('artifacts', dir, item.url)))
          hash.update(chunk);
        if (hash.digest('base64') !== item.sha512)
          throw new Error('Artifact checksum mismatch: ' + item.url);
      }
      if (name === 'latest-mac.yml') {
        mac.push(meta);
        continue;
      }
    }
    if (names.has(name)) throw new Error('Duplicate release asset: ' + name);
    names.add(name);
    await copyFile(file, path.join('release-assets', name));
  }
}
for (const suffix of [
  'win-x64.exe',
  'mac-x64.dmg',
  'mac-arm64.dmg',
  'mac-x64.zip',
  'mac-arm64.zip',
])
  if (![...names].some((name) => name.endsWith(suffix)))
    throw new Error('Missing platform package: ' + suffix);
if (mac.length !== 2 || !names.has('latest.yml')) throw new Error('Missing updater metadata');
await writeFile(
  'release-assets/latest-mac.yml',
  YAML.stringify({ ...mac[0], files: mac.flatMap((m) => m.files) }),
);
console.log(`Verified ${names.size} assets and merged both macOS architectures.`);
