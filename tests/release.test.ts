import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('merges architecture-specific update manifests only after checking complete packages and hashes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-release-'));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.5.8' }));
  for (const target of ['win-x64', 'mac-x64', 'mac-arm64']) {
    const directory = path.join(root, 'artifacts', target);
    mkdirSync(directory, { recursive: true });
    const files = (target.startsWith('win') ? ['exe'] : ['zip', 'dmg']).map((ext) => {
      const url = `Tongzhou-0.5.8-${target}.${ext}`;
      writeFileSync(path.join(directory, url), url);
      return { url, sha512: createHash('sha512').update(url).digest('base64') };
    });
    writeFileSync(
      path.join(directory, target.startsWith('win') ? 'latest.yml' : 'latest-mac.yml'),
      YAML.stringify({ version: '0.5.8', files }),
    );
  }
  const script = path.resolve('scripts/merge-release-artifacts.mjs');
  execFileSync(process.execPath, [script], { cwd: root });
  const manifest = YAML.parse(
    readFileSync(path.join(root, 'release-assets/latest-mac.yml'), 'utf8'),
  );
  expect(manifest.files).toHaveLength(4);
  expect(manifest.files.some((f: any) => f.url.endsWith('mac-arm64.zip'))).toBe(true);
  writeFileSync(path.join(root, 'artifacts/win-x64/Tongzhou-0.5.8-win-x64.exe'), 'corrupt');
  expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' })).toThrow();
});
