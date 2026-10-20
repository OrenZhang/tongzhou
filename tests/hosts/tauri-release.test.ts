import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
it('merges only matching Tauri versions and refuses duplicate platform replacements', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tauri-release-'));
  const script = path.resolve('scripts/tauri-release.mjs');
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    const directory = path.join(root, 'updates');
    await mkdir(directory);
    const entry = {
      signature: 'public-signature',
      url: 'https://github.com/OrenZhang/tongzhou/releases/download/v2.0.0/native.app.tar.gz',
    };
    await writeFile(
      path.join(directory, 'darwin-aarch64.json'),
      JSON.stringify({ version: '2.0.0', platforms: { 'darwin-aarch64': entry } }),
    );
    execFileSync(process.execPath, [script, 'merge', directory], { cwd: root, stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(path.join(directory, 'tauri-latest.json'), 'utf8'));
    expect(manifest.platforms).toEqual({ 'darwin-aarch64': entry });
    await writeFile(
      path.join(directory, 'windows-x86_64.json'),
      JSON.stringify({ version: '2.1.0', platforms: { 'windows-x86_64': entry } }),
    );
    expect(() =>
      execFileSync(process.execPath, [script, 'merge', directory], { cwd: root, stdio: 'pipe' }),
    ).toThrow();
    await writeFile(
      path.join(directory, 'windows-x86_64.json'),
      JSON.stringify({ version: '2.0.0', platforms: { 'darwin-aarch64': entry } }),
    );
    expect(() =>
      execFileSync(process.execPath, [script, 'merge', directory], { cwd: root, stdio: 'pipe' }),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
