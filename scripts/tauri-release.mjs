import { readdir, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const command = process.argv[2] ?? 'collect';
async function files(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? files(path.join(directory, entry.name))
          : path.join(directory, entry.name),
      ),
    )
  ).flat();
}
if (command === 'collect') {
  const os = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform];
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  assert.ok(os && arch, 'unsupported updater platform');
  const target = `${os}-${arch}`;
  const extension =
    process.platform === 'darwin'
      ? '.app.tar.gz'
      : process.platform === 'win32'
        ? '-setup.exe'
        : '.AppImage';
  const artifacts = (await files('src-tauri/target/release/bundle')).filter((file) =>
    file.endsWith(extension),
  );
  assert.equal(artifacts.length, 1, 'expected one signed Tauri update bundle');
  const source = artifacts[0],
    signature = (await readFile(source + '.sig', 'utf8')).trim();
  assert.ok(signature, 'missing update signature');
  const directory = path.resolve(process.argv[3] ?? 'work/tauri-release');
  await mkdir(directory, { recursive: true });
  const name = `CoSail-Tauri-${version}-${target}${process.platform === 'darwin' ? '.app.tar.gz' : process.platform === 'win32' ? '-setup.exe' : '.AppImage'}`;
  await cp(source, path.join(directory, name));
  await cp(source + '.sig', path.join(directory, name + '.sig'));
  await writeFile(
    path.join(directory, `${target}.json`),
    JSON.stringify(
      {
        version,
        platforms: {
          [target]: {
            signature,
            url: `https://github.com/OrenZhang/tongzhou/releases/download/v${version}/${name}`,
          },
        },
      },
      null,
      2,
    ),
  );
  console.log(`Prepared signed Tauri update: ${target}`);
} else if (command === 'merge') {
  const directory = path.resolve(process.argv[3] ?? 'work/tauri-release');
  const platforms = {};
  let count = 0;
  for (const file of await files(directory)) {
    if (!/(darwin|windows|linux)-(aarch64|x86_64)\.json$/.test(file)) continue;
    const fragment = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(fragment.version, version);
    for (const [target, entry] of Object.entries(fragment.platforms)) {
      assert.ok(!platforms[target], `duplicate ${target}`);
      assert.ok(
        entry.signature &&
          entry.url.startsWith(
            `https://github.com/OrenZhang/tongzhou/releases/download/v${version}/`,
          ),
      );
      platforms[target] = entry;
      count++;
    }
  }
  assert.ok(count, 'no signed platform manifests');
  await writeFile(
    path.join(directory, 'tauri-latest.json'),
    JSON.stringify(
      {
        version,
        notes: 'CoSail Tauri desktop update',
        pub_date: new Date().toISOString(),
        platforms,
      },
      null,
      2,
    ),
  );
  console.log(`Prepared Tauri-only manifest: ${count} platforms`);
} else throw new Error('Use collect or merge');
