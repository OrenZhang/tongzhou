import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
const roots: string[] = [];
it('allows only release commits, tags in release ancestry, and manual release dispatch', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-release-source-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  git('add', 'package.json');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Release base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/release', base);
  const run = (event: string, ref: string) =>
    execFileSync(process.execPath, [path.resolve('scripts/release-version.mjs')], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref },
    });
  expect(() => run('push', 'refs/heads/release')).not.toThrow();
  expect(() => run('workflow_dispatch', 'refs/heads/release')).not.toThrow();
  expect(() => run('push', 'refs/tags/v0.1.0')).not.toThrow();
  expect(() => run('workflow_dispatch', 'refs/heads/main')).toThrow();
  expect(() => run('workflow_dispatch', 'refs/tags/v0.1.0')).toThrow();
  expect(() => run('push', 'refs/tags/v0.5.9')).toThrow();
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Unreleased work');
  expect(() => run('push', 'refs/tags/v0.1.0')).toThrow();
  const candidate = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/release', candidate);
  expect(() => run('push', 'refs/tags/v0.1.0')).not.toThrow();
  git('checkout', '--detach', base);
  expect(() => run('push', 'refs/tags/v0.1.0')).not.toThrow();
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('merges architecture-specific update manifests only after checking complete packages and hashes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-release-'));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  for (const target of ['win-x64', 'mac-x64', 'mac-arm64']) {
    const directory = path.join(root, 'artifacts', target);
    mkdirSync(directory, { recursive: true });
    const files = (target.startsWith('win') ? ['exe'] : ['zip', 'dmg']).map((ext) => {
      const url = `Tongzhou-0.1.0-${target}.${ext}`;
      writeFileSync(path.join(directory, url), url);
      return { url, sha512: createHash('sha512').update(url).digest('base64') };
    });
    writeFileSync(
      path.join(directory, target.startsWith('win') ? 'latest.yml' : 'latest-mac.yml'),
      YAML.stringify({ version: '0.1.0', files }),
    );
  }
  const linuxDirectory = path.join(root, 'artifacts', 'linux-amd64');
  mkdirSync(linuxDirectory, { recursive: true });
  const linuxFiles = [
    'Tongzhou-0.1.0-linux-x86_64.AppImage',
    'Tongzhou-0.1.0-linux-x86_64.AppImage.blockmap',
    'Tongzhou-0.1.0-linux-amd64.deb',
  ].map((url) => {
    writeFileSync(path.join(linuxDirectory, url), url);
    return { url, sha512: createHash('sha512').update(url).digest('base64') };
  });
  writeFileSync(
    path.join(linuxDirectory, 'latest-linux.yml'),
    YAML.stringify({ version: '0.1.0', files: linuxFiles }),
  );
  const script = path.resolve('scripts/merge-release-artifacts.mjs');
  execFileSync(process.execPath, [script], { cwd: root });
  const manifest = YAML.parse(
    readFileSync(path.join(root, 'release-assets/latest-mac.yml'), 'utf8'),
  );
  expect(manifest.files).toHaveLength(4);
  expect(manifest.files.some((f: any) => f.url.endsWith('mac-arm64.zip'))).toBe(true);
  writeFileSync(path.join(root, 'artifacts/win-x64/Tongzhou-0.1.0-win-x64.exe'), 'corrupt');
  expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' })).toThrow();
  writeFileSync(
    path.join(root, 'artifacts/win-x64/Tongzhou-0.1.0-win-x64.exe'),
    'Tongzhou-0.1.0-win-x64.exe',
  );
  writeFileSync(
    path.join(root, 'artifacts/linux-amd64/Tongzhou-0.1.0-linux-amd64.deb'),
    'corrupt',
  );
  expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' })).toThrow();
});
