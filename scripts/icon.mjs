// CoSail double-sail mark rasterized from the project's vector geometry. No external assets.
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
const samples = 4;
const { background, polygons } = JSON.parse(
  await readFile(new URL('../src/shared/brand-mark.json', import.meta.url), 'utf8'),
);
function inside(x, y, p) {
  let yes = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    if (
      p[i][1] > y !== p[j][1] > y &&
      x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]
    )
      yes = !yes;
  return yes;
}
function render(size, scale = 1) {
  const inset = (256 * (1 - scale)) / 2;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const out = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const px = (((x + (sx + 0.5) / samples) * 256) / size - inset) / scale,
            py = (((y + (sy + 0.5) / samples) * 256) / size - inset) / scale;
          const cx = Math.max(58, Math.min(198, px)),
            cy = Math.max(58, Math.min(198, py));
          if (Math.hypot(px - cx, py - cy) > 58) continue;
          let color = background;
          for (const poly of polygons)
            if (inside((px - 32) / 4.8, (py - 25) / 4.8, poly.p)) color = poly.color;
          color.forEach((v, i) => (out[i] += v));
          out[3] += 255;
        }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const alpha = out[3] / (samples * samples);
      for (let i = 0; i < 3; i++) raw[offset + i] = alpha ? Math.round((out[i] * 255) / out[3]) : 0;
      raw[offset + 3] = Math.round(alpha);
    }
  function crc(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const typeBytes = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const png = render(256);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await mkdir('build', { recursive: true });
await writeFile('build/icon.png', render(512));
// macOS reserves transparent margins around Dock icons. Match native app sizing.
const macScale = 0.8;
await writeFile('build/icon-mac.png', render(512, macScale));
await writeFile('build/icon.ico', Buffer.concat([ico, png]));
// Portable fallback; macOS below uses Icon Services for native small icons and Retina variants.
const iconEntries = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
].map(([type, size]) => {
  const data = render(size, macScale);
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
});
const iconHeader = Buffer.alloc(8);
iconHeader.write('icns', 0, 'ascii');
iconHeader.writeUInt32BE(8 + iconEntries.reduce((size, entry) => size + entry.length, 0), 4);
await writeFile('build/icon.icns', Buffer.concat([iconHeader, ...iconEntries]));
if (process.platform === 'darwin') {
  // Let Icon Services encode its small ARGB representations and Retina variants.
  const directory = await mkdtemp(path.join(tmpdir(), 'cosail-icon-'));
  const iconset = path.join(directory, 'CoSail.iconset');
  try {
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512])
      for (const scale of [1, 2])
        await writeFile(
          path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
          render(size * scale, macScale),
        );
    await promisify(execFile)('/usr/bin/iconutil', [
      '-c',
      'icns',
      '-o',
      path.resolve('build/icon.icns'),
      iconset,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const rgb = (color) => 'rgb(' + color.join(',') + ')';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="CoSail"><rect width="256" height="256" rx="58" fill="' +
  rgb(background) +
  '"/><g transform="translate(32 25) scale(4.8)">' +
  polygons
    .map(
      ({ p, color }) =>
        '<polygon points="' +
        p.map((point) => point.join(',')).join(' ') +
        '" fill="' +
        rgb(color) +
        '"/>',
    )
    .join('') +
  '</g></svg>\n';
await writeFile('docs/assets/logo.svg', svg);
await writeFile('public/cosail.svg', svg);
