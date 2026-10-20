import { it, expect } from 'vitest';
import { statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Arch } from 'builder-util';
import path from 'node:path';
import { FileMatcher } from 'app-builder-lib/out/fileMatcher';
import pkg from '../../package.json';
// @ts-expect-error Build hooks are native ESM scripts.
import afterPack from '../../scripts/after-pack.mjs';

// Use builder's real matcher: a valid-looking glob can accidentally strip native helpers.
for (const [platform, native] of [
  ['mac', 'darwin'],
  ['win', 'win32'],
  ['linux', 'linux'],
] as const) {
  for (const arch of ['arm64', 'x64']) {
    it(`keeps runtime resources and only target PTY prebuilds for ${platform}/${arch}`, async () => {
      const root = process.cwd();
      const matcher = new FileMatcher(root, root, (value) => value, [
        '**/*',
        ...pkg.build.files.filter((pattern) => pattern.startsWith('!')),
      ]).createFilter();
      const file = statSync('package.json');
      const includes = (name: string) => matcher(path.join(root, 'node_modules', name), file);
      for (const name of [
        `node-pty/prebuilds/${native}-${arch}/pty.node`,
        `node-pty/prebuilds/${native}-${arch}/spawn-helper`,
        `node-pty/prebuilds/${native}-${arch}/conpty/OpenConsole.exe`,
        'node-pty/build/Release/pty.node',
        'node-pty/lib/unixTerminal.js',
        'node-pty/LICENSE',
        'node/bin/node',
        'node/bin/node.exe',
        '@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
        '@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-resources/voice/bin/codex-voice-host',
        '@moonshot-ai/kimi-code/dist/main.mjs',
        '@minimax-ai/code/assets/fonts/font.ttf',
        '@minimax-ai/code/photon_rs_bg.wasm',
        'better-sqlite3/build/Release/better_sqlite3.node',
        'better-sqlite3/lib/database.js',
        '@vscode/ripgrep-darwin-arm64/bin/rg',
        'electron-updater/out/main.js',
      ])
        expect(includes(name), name).toBe(true);
      for (const name of [
        'some-package/index.js.map',
        '@moonshot-ai/kimi-code/dist-web/assets/font.woff2',
        '@moonshot-ai/kimi-code/dist-web/index.html',
        '@moonshot-ai/kimi-code/scripts/postinstall.mjs',
        '@moonshot-ai/kimi-code/scripts/postinstall/manifest.json',
        '@minimax-ai/code/verify-native-install.mjs',
        'node/installArchSpecificPackage.js',
        'node-pty/src/unix/pty.cc',
        'node-pty/lib/unixTerminal.test.js',
        'better-sqlite3/deps/sqlite3/sqlite3.c',
        'better-sqlite3/build/Release/obj/gen/sqlite3/sqlite3.c',
      ])
        expect(includes(name), name).toBe(false);
      const out = mkdtempSync(path.join(tmpdir(), 'cosail-package-'));
      const resources = path.join(out, 'resources');
      const prebuilds = path.join(resources, 'app.asar.unpacked/node_modules/node-pty/prebuilds');
      const targets = [
        'darwin-arm64',
        'darwin-x64',
        'win32-arm64',
        'win32-x64',
        'linux-arm64',
        'linux-x64',
      ];
      try {
        for (const target of targets) {
          mkdirSync(path.join(prebuilds, target), { recursive: true });
          writeFileSync(path.join(prebuilds, target, 'helper'), target);
        }
        writeFileSync(path.join(out, 'cosail'), 'linux executable');
        await afterPack({
          appOutDir: out,
          arch: Arch[arch as 'arm64' | 'x64'],
          electronPlatformName: native,
          packager: { getResourcesDir: () => resources },
        });
        for (const target of targets)
          expect(existsSync(path.join(prebuilds, target, 'helper')), target).toBe(
            target === `${native}-${arch}`,
          );
        if (native === 'linux') expect(existsSync(path.join(out, 'cosail.bin'))).toBe(true);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  }
}
