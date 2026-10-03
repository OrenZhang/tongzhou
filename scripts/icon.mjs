// Original sail mark rasterized from the project's vector geometry. No external assets.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
const samples = 4;
const background = [75, 94, 140]; // #4b5e8c, shared with the interface accent and SVG logo.
const polygons = [
  {
    p: [
      [20, 5],
      [20, 28],
      [7, 28],
    ],
    color: [255, 255, 255],
  },
  {
    p: [
      [24, 11],
      [24, 28],
      [34, 28],
    ],
    color: background.map((channel) => Math.round(255 * 0.55 + channel * 0.45)),
  },
  {
    p: [
      [5, 31],
      [36, 31],
      [30, 36],
      [12, 36],
    ],
    color: [255, 255, 255],
  },
];
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
function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const out = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const px = ((x + (sx + 0.5) / samples) * 256) / size,
            py = ((y + (sy + 0.5) / samples) * 256) / size;
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
await writeFile('build/icon.ico', Buffer.concat([ico, png]));
