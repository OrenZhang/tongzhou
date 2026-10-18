import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../../electron/services/storage/store';
import { createDomainServices } from '../../../electron/modules/domain-services';
import { importCanvasResources } from '../../../electron/modules/canvas/import-resources';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cosail-resource-import-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanups.push(() => store.close());
  return { root, store, ...createDomainServices(store, root) };
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
  'base64',
);

it('copies an external image and keeps a usable, deduplicated canvas reference after the original is removed', async () => {
  const { root, knowledge, canvasWorkflows } = await fixture();
  const file = path.join(root, '人物.PNG');
  await writeFile(file, png);
  const result = await importCanvasResources(knowledge, [file, file], 'image');
  expect(result.errors).toEqual([]);
  expect(result.choices).toHaveLength(1);
  expect((await importCanvasResources(knowledge, [file], 'image')).choices).toEqual(result.choices);
  await rm(file);
  const ref = result.choices[0].resource;
  expect(canvasWorkflows.resources.preview(ref).type).toBe('image');
  if (ref.kind !== 'content') throw new Error('Expected managed content');
  expect(knowledge.originalBytes(ref.id)).toEqual(png);
});

it('preserves successful imports and reports wrong media, folders, missing and oversized files', async () => {
  const { root, knowledge } = await fixture();
  const valid = path.join(root, 'image.png'),
    text = path.join(root, 'note.txt'),
    large = path.join(root, 'large.png');
  await writeFile(valid, png);
  await writeFile(text, 'notes');
  await writeFile(large, Buffer.alloc(25 * 1024 * 1024 + 1));
  const result = await importCanvasResources(
    knowledge,
    [valid, text, large, path.join(root, 'missing.png')],
    'image',
  );
  expect(result.choices).toHaveLength(1);
  expect(result.errors).toHaveLength(3);
  expect(result.errors.join('\n')).toContain('25 MB');
  expect((await importCanvasResources(knowledge, [root])).errors[0]).toContain('文件夹');
});

it('imports text as usable input and permits supported audio and video resources', async () => {
  const { root, knowledge, canvasWorkflows } = await fixture();
  for (const [name, content, media] of [
    ['novel.txt', '人物：小舟', undefined],
    ['voice.wav', 'RIFFaudio', 'audio'],
    ['clip.mp4', 'video', 'video'],
  ] as const) {
    const file = path.join(root, name);
    await writeFile(file, content);
    const result = await importCanvasResources(knowledge, [file], media);
    expect(result.errors).toEqual([]);
    expect(result.choices).toHaveLength(1);
    if (!media)
      expect((await canvasWorkflows.resources.resolve(result.choices[0].resource)).text).toBe(
        content,
      );
  }
});

it('loads editable HTML and SVG source from local imports, refreshes library revisions and rejects images', async () => {
  const { root, knowledge, canvasWorkflows, content } = await fixture();
  for (const [name, text] of [
    ['page.html', '<h1>同舟</h1>'],
    ['drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  ]) {
    const file = path.join(root, name);
    await writeFile(file, text);
    const ref = (await importCanvasResources(knowledge, [file])).choices[0].resource;
    await rm(file);
    expect((await canvasWorkflows.resources.readTextSource(ref)).text).toBe(text);
  }
  const doc = content.write({ libraryId: 'default', title: '页面', content: '<h1>旧版本</h1>' });
  content.write({
    id: doc.id,
    version: doc.version,
    libraryId: 'default',
    title: '页面',
    content: '<h1>新版本</h1>',
  });
  const refreshed = await canvasWorkflows.resources.readTextSource({
    kind: 'content',
    id: doc.id,
    version: doc.version,
  });
  expect(refreshed.text).toBe('<h1>新版本</h1>');
  expect(refreshed.resource).toMatchObject({ version: doc.version + 1 });
  const image = knowledge.importFile('image.png', png);
  await expect(
    canvasWorkflows.resources.readTextSource({
      kind: 'content',
      id: image.id,
      version: image.version,
    }),
  ).rejects.toThrow('文本资源');
  const large = knowledge.importFile('large.html', Buffer.from('a'.repeat(32001)));
  await expect(
    canvasWorkflows.resources.readTextSource({
      kind: 'content',
      id: large.id,
      version: large.version,
    }),
  ).rejects.toThrow('32,000');
});

it('reads complete artifact source and persists an editable snapshot independently of its original', async () => {
  const { store, artifacts, canvasWorkflows, canvases } = await fixture();
  const session = store.createSession(),
    runId = randomUUID();
  store.put('run', { id: runId, sessionId: session.id, status: 'completed' });
  const artifact = await artifacts.save(
    { name: 'page.html', text: '<h1>作品</h1>' },
    { sessionId: session.id, runId },
  );
  const loaded = await canvasWorkflows.resources.readTextSource({
    kind: 'artifact',
    id: artifact.id,
  });
  expect(loaded.text).toBe('<h1>作品</h1>');
  const canvas = canvases.save({
    title: '页面',
    nodes: [
      {
        id: 'html',
        kind: 'plugin',
        pluginId: 'visual.html',
        title: 'HTML',
        x: 0,
        y: 0,
        text: '<h1>本地修改</h1>',
        resource: loaded.resource,
        textSource: { title: artifact.name },
      },
    ],
    edges: [],
    selection: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  expect(canvases.state(canvas.id).canvas?.nodes[0].textSource).toEqual({ title: 'page.html' });
  expect(artifacts.preview(artifact.id).content).toBe('<h1>作品</h1>');
  const large = await artifacts.save(
    { name: 'large.html', data: Buffer.from('a'.repeat(200001)).toString('base64') },
    { sessionId: session.id, runId },
  );
  await expect(
    canvasWorkflows.resources.readTextSource({ kind: 'artifact', id: large.id }),
  ).rejects.toThrow('32,000');
});
