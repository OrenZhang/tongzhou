import { createRequire } from 'node:module';
import path from 'node:path';
import { clipboard } from 'electron';
import { deflateSync } from 'node:zlib';

/**
 * Bundled N-API addon (build/computer/linux-x11). N-API is ABI-stable, so the
 * same binary loads in the Electron main process. All security checks stay in
 * computer.ts; this module only talks to the X server.
 */
type LinuxX11 = {
  available(): boolean;
  listWindows(): string;
  activate(id: string, pid: number): string;
  click(id: string, pid: number, x: number, y: number, button: string, count: number): string;
  pressKey(id: string, pid: number, spec: string): string;
  scroll(id: string, pid: number, x: number, y: number, amount: number): string;
  drag(id: string, pid: number, x: number, y: number, toX: number, toY: number): string;
  releaseAll(): string;
  capture(id: string, pid: number): { data: Buffer; width: number; height: number };
  pasteChord(id: string, pid: number): string;
  clipBeginRead(target: 'utf8' | 'string'): string;
  clipService(): { read: 'idle' | 'pending' | 'done'; served: boolean; text?: string };
  clipPublish(text: string): string;
  clipRelease(): void;
};

export type X11Capture = { data: Buffer; width: number; height: number };

let addon: LinuxX11 | undefined;
function load(): LinuxX11 {
  if (!addon) {
    const file = path
      .join(__dirname, '../build/computer/linux-x11/computer-x11.node')
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    addon = createRequire(path.join(__dirname, '../package.json'))(file) as LinuxX11;
  }
  return addon!;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cached: boolean | undefined;
export function x11Available(): boolean {
  if (cached === undefined)
    try {
      cached = load().available();
    } catch {
      cached = false;
    }
  return cached;
}

/*
 * Paste-based typing. The addon must never block the event loop for long:
 * the paste target asks its browser process for the clipboard over IPC, and
 * the current owner may be this very app — both only progress while the main
 * thread breathes between ticks. The clipboard is restored afterwards.
 */
async function typeViaClipboard(
  id: string,
  pid: number,
  text: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  const m = load();
  let previous: string | undefined;
  for (let read = 0; read < 3 && previous === undefined; read++) {
    m.clipBeginRead('utf8');
    for (let i = 0; i < 30; i++) {
      signal?.throwIfAborted();
      await delay(50);
      const state = m.clipService();
      if (state.read === 'done') {
        previous = state.text ?? '';
        break;
      }
    }
    // A clipboard written moments ago may not have claimed X ownership yet;
    // give it one more beat before treating the clipboard as empty.
    if (previous === '' && read < 2) await delay(120);
  }
  m.clipPublish(text);
  try {
    m.pasteChord(id, pid);
    /* Serve the target's selection fetches. Chromium reads the clipboard in
     * several sequential blocking steps, so keep answering for a minimum
     * window after the first data request instead of releasing early. */
    let elapsed = 0;
    let servedAt = -1;
    for (let i = 0; i < 50; i++) {
      signal?.throwIfAborted();
      await delay(40);
      elapsed += 40;
      if (m.clipService().served && servedAt < 0) servedAt = elapsed;
      if (servedAt >= 0 && elapsed - servedAt >= 700) break;
    }
  } finally {
    m.clipRelease();
    // Restore through the native clipboard, which can own and serve the
    // selection beyond this call.
    if (previous) clipboard.writeText(previous);
  }
  return { ok: true };
}

export async function x11Run(payload: any, signal?: AbortSignal): Promise<unknown> {
  const m = load();
  const w = payload.window ?? {};
  switch (payload.action) {
    case 'windows':
      return JSON.parse(m.listWindows());
    case 'release':
      m.releaseAll();
      return { ok: true };
    case 'click':
      m.click(w.id, w.pid, payload.x, payload.y, payload.button ?? 'left', payload.clickCount ?? 1);
      return { ok: true };
    case 'type':
      return typeViaClipboard(w.id, w.pid, payload.text, signal);
    case 'key':
      m.pressKey(w.id, w.pid, payload.key);
      return { ok: true };
    case 'scroll':
      m.scroll(w.id, w.pid, payload.x, payload.y, payload.amount);
      return { ok: true };
    case 'drag':
      m.drag(w.id, w.pid, payload.x, payload.y, payload.toX, payload.toY);
      return { ok: true };
    case 'capture':
      return m.capture(payload.windowId, payload.pid) as X11Capture;
    default:
      throw new Error('Unknown action');
  }
}

/* ---------- minimal PNG encoder (RGBA8) ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  return Buffer.concat([head, body, tail]);
}

/** Encode raw RGBA pixels into a PNG image (color type 6, 8-bit, filter none). */
export function rgbaToPng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  if (rgba.length < stride * height) throw new Error('RGBA buffer smaller than width×height');
  // PNG scanlines carry one leading filter byte per row.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
