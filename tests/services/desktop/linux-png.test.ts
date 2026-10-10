import { inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { crc32, rgbaToPng } from '../../../electron/services/desktop/linux-computer';

function parsePng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const chunks: { type: string; data: Buffer; crc: number }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    chunks.push({ type, data, crc });
    offset += 12 + length;
  }
  return chunks;
}

it('encodes RGBA pixels as a structurally valid PNG with round-trip pixels', () => {
  // 2×2: red, green / blue, white
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const png = rgbaToPng(2, 2, rgba);
  const chunks = parsePng(png);
  for (const chunk of chunks) {
    expect(crc32(Buffer.concat([Buffer.from(chunk.type), chunk.data]))).toBe(chunk.crc);
  }
  expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  expect(ihdr.readUInt32BE(0)).toBe(2);
  expect(ihdr.readUInt32BE(4)).toBe(2);
  expect([ihdr[8], ihdr[9]]).toEqual([8, 6]);
  const raw = inflateSync(chunks[1].data);
  // Two scanlines, each with a leading filter byte (0 = none).
  expect(raw.length).toBe((2 * 4 + 1) * 2);
  expect(raw[0]).toBe(0);
  expect(raw.subarray(1, 9)).toEqual(rgba.subarray(0, 8));
  expect(raw[9]).toBe(0);
  expect(raw.subarray(10, 18)).toEqual(rgba.subarray(8, 16));
});

it('rejects buffers smaller than width×height', () => {
  expect(() => rgbaToPng(2, 2, Buffer.alloc(4))).toThrow('RGBA buffer smaller');
});
