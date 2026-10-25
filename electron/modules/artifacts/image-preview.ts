import type { ArtifactPreview } from '../../../src/shared/artifacts';

/** Render raster originals as data URLs; never expose local filesystem URLs to the renderer. */
export function imagePreview(bytes: Buffer, maxBytes: number): ArtifactPreview {
  if (bytes.length > maxBytes) throw new Error('图片原件超过预览大小限制');
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
          ? 'image/gif'
          : undefined;
  if (!mimeType) throw new Error('图片原件格式无效');
  return { type: 'image', content: `data:${mimeType};base64,${bytes.toString('base64')}` };
}
