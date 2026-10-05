import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const files = (await readdir('release')).filter((name) => /\.(exe|dmg|zip)$/.test(name));
if (!files.length) throw new Error('No release binaries found');
const lines = [];
for (const file of files) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path.join('release', file))) hash.update(data);
  lines.push(hash.digest('hex') + '  ' + file);
}
await writeFile(
  `release/SHA256SUMS-${process.platform}-${process.arch}.txt`,
  lines.join('\n') + '\n',
);
