import { openSidebar } from './navigation-helper.mjs';
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/artifacts-'));
let png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw),
    lastUser = body.messages.findLastIndex((m) => m.role === 'user');
  const results = body.messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
  const done = results.length >= 3;
  const doc = results
    .map((m) => {
      try {
        return JSON.parse(m.content);
      } catch {
        return null;
      }
    })
    .find((a) => a?.name === '整理结果.md');
  const calls = [
    { name: '测试图片.png', url: 'https://media-fixture.invalid/image.png' },
    { name: '整理结果.md', text: '# 整理结果\n\n结构清晰的文档。' },
  ];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: done
              ? { content: '已生成两件作品，可以继续整理或保存到内容库。' }
              : {
                  tool_calls: doc
                    ? [
                        {
                          index: 0,
                          id: 'request-save',
                          function: {
                            name: 'client_change',
                            arguments: JSON.stringify({
                              method: 'artifactToKnowledge',
                              args: [doc.id, 'default', null, '文章成果'],
                            }),
                          },
                        },
                      ]
                    : calls.map((a, i) => ({
                        index: i,
                        id: 'create-' + i,
                        function: { name: 'artifact_create', arguments: JSON.stringify(a) },
                      })),
                },
            finish_reason: done ? 'stop' : 'tool_calls',
          },
        ],
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = {
  ...process.env,
  TONGZHOU_USER_DATA: path.join(root, 'profile'),
  TONGZHOU_DISABLE_UPDATES: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
async function launch() {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await page.setViewportSize({ width: 1440, height: 1000 });
  return page;
}
async function waitFor(page, fn, arg) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn, arg)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('Condition did not become true: ' + fn.toString());
}
try {
  let page = await launch();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  png = await app.evaluate(({ nativeImage }) => {
    const width = 720,
      height = 420;
    const bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        bitmap[offset] = 170;
        bitmap[offset + 1] = Math.round((x / width) * 200);
        bitmap[offset + 2] = Math.round((y / height) * 200);
        bitmap[offset + 3] = 255;
      }
    }
    return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG().toString('base64');
  });
  await app.evaluate(({ session }, data) => {
    globalThis.mediaDownloadCount = 0;
    const serviceSession = session.fromPartition('tongzhou-service-network');
    const originalFetch = serviceSession.fetch.bind(serviceSession);
    serviceSession.fetch = async (input, options) => {
      if (new URL(input).hostname !== 'media-fixture.invalid') return originalFetch(input, options);
      globalThis.mediaDownloadCount++;
      if (globalThis.mediaDownloadCount === 2)
        return new Response('Temporary download failure', { status: 503 });
      return new Response(Buffer.from(data, 'base64'), {
        headers: { 'content-type': 'image/png' },
      });
    };
  }, png);
  const session = await page.evaluate(async (baseUrl) => {
    const api = window.tongzhou;
    await api.saveProvider({
      id: 'artifacts-fixture',
      name: '作品测试',
      protocol: 'openai-chat',
      baseUrl,
      auth: 'none',
      models: ['fixture'],
      maxOutputTokens: 1000,
      contextChars: 50000,
    });
    await api.knowledgeSettings({ autoCollect: false });
    const s = await api.createSession();
    await api.updateSession(s.id, {
      title: '生成作品测试',
      providerId: 'artifacts-fixture',
      model: 'fixture',
    });
    await api.run({
      sessionId: s.id,
      providerId: 'artifacts-fixture',
      model: 'fixture',
      agentId: '',
      prompt: '生成一张图片和一个文档作品用于验证',
    });
    return s;
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await waitFor(page, async () => {
    const runs = (await window.tongzhou.snapshot()).runs;
    return runs.length > 0 && runs.every((r) => r.status !== 'running');
  });
  const works = await page.evaluate(() => window.tongzhou.artifactList());
  assert.equal(works.total, 2);
  const generatedImage = works.items.find((item) => item.kind === 'image');
  assert.equal(generatedImage.remoteUrl, undefined);
  assert.equal(generatedImage.sourceUrl, 'https://media-fixture.invalid/image.png');
  assert.equal(await app.evaluate(() => globalThis.mediaDownloadCount), 1);
  assert.equal(
    (await page.evaluate(() => window.tongzhou.contentState('default'))).documents.length,
    1,
  );
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.getByRole('button', { name: '查看作品 测试图片.png', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector('.artifact-strip .artifact-image-card img');
    return image?.complete && image.naturalWidth === 720;
  });
  assert.equal(await page.locator('.artifact-strip .file-link').count(), 1);
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await page.locator('.artifact-image-card img').evaluate((img) => {
      const box = img.getBoundingClientRect();
      return { width: box.width, height: box.height, right: box.right, viewport: innerWidth };
    });
    assert.ok(bounds.width > 100 && bounds.width <= 480);
    assert.ok(bounds.height > 0 && bounds.height <= 360);
    assert.ok(bounds.right <= bounds.viewport);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(root, 'chat-inline-image.png') });
  await page.getByRole('button', { name: '查看作品 测试图片.png', exact: true }).click();
  await page.locator('.artifact-preview img').waitFor();
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
  // Simulate a pre-upgrade remote-only record. Opening history should download it, not regenerate.
  const recordPath = path.join(
    root,
    'profile/.tzhou/artifacts/records',
    generatedImage.id + '.json',
  );
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.remoteUrl = record.sourceUrl;
  delete record.blob;
  delete record.sourceUrl;
  delete record.size;
  record.hash = createHash('sha256').update(record.remoteUrl).digest('hex');
  await writeFile(recordPath, JSON.stringify(record));
  await page.reload();
  await page.waitForSelector('.app-shell');
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.getByRole('button', { name: '重试加载', exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.mediaDownloadCount), 2);
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.artifact-image-card img')?.naturalWidth === 720,
  );
  assert.equal(await app.evaluate(() => globalThis.mediaDownloadCount), 3);
  assert.equal((await page.evaluate(() => window.tongzhou.artifactList())).total, 2);
  // A decode failure must leave the original file action accessible.
  await page.locator('.artifact-image-card img').dispatchEvent('error');
  await page.locator('.artifact-strip .file-link').filter({ hasText: '测试图片.png' }).waitFor();
  await page.reload();
  await page.waitForSelector('.app-shell');
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.waitForFunction(() => {
    const image = document.querySelector('.artifact-strip .artifact-image-card img');
    return image?.complete && image.naturalWidth === 720;
  });
  await page.getByRole('button', { name: '查看作品 整理结果.md', exact: true }).click();
  await page.locator('.artifact-preview pre').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByLabel('消息', { exact: true }).fill('文件预览时仍可继续沟通');
  await page.screenshot({ path: path.join(root, 'chat-file-workspace.png') });
  await page.getByLabel('消息', { exact: true }).fill('');
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();

  assert.equal(await page.locator('.artifact-strip .artifact-card').count(), 2);
  await page.screenshot({ path: path.join(root, 'chat-file-links.png'), animations: 'disabled' });
  assert.equal(await page.locator('.workspace-navigation').count(), 0);
  for (const name of ['Agent', '智库', '插件', '运行记录', '定时任务', '设置'])
    assert.equal(
      await page.locator('.sidebar-rail').getByRole('button', { name, exact: true }).count(),
      1,
    );
  await page.getByRole('button', { name: '会话作品', exact: true }).click();
  assert.equal(await page.getByLabel('作品来源会话', { exact: true }).inputValue(), session.id);
  await page.getByRole('button', { name: '查看作品 测试图片.png', exact: true }).click();
  await page.locator('.artifact-preview img').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('complementary', { name: '文件工作区' }).count(), 1);
  await app.evaluate(
    ({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    },
    path.join(root, 'download.png'),
  );
  await page.getByRole('button', { name: '下载', exact: true }).click();
  await page.getByText('作品已下载', { exact: true }).waitFor();
  assert.equal((await readFile(path.join(root, 'download.png'))).toString('base64'), png);
  await page.getByRole('button', { name: '整理内容', exact: true }).click();
  await page.getByLabel('整理要求', { exact: true }).fill('描述图片，并整理为一篇文档');
  await page.getByRole('button', { name: '前往会话整理', exact: true }).click();
  await waitFor(page, () =>
    document.querySelector('.composer textarea')?.value.includes('描述图片'),
  );
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: /^作品/ }).click();
  await page.getByRole('button', { name: '查看作品 整理结果.md', exact: true }).click();
  const content = await page.evaluate(() => window.tongzhou.contentState('default'));
  assert.equal(content.documents.length, 1);
  assert.equal(content.documents[0].title, '整理结果.md');
  assert.equal(
    content.folders.find((f) => f.id === content.documents[0].folderId).name,
    '文章成果',
  );
  assert.equal(await page.getByText('待确认入库', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
  assert.ok(
    content.folders.every((f) => !('usageEnabled' in f)),
    'saving a work must not enable AI usage',
  );
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.getByRole('button', { name: '会话作品', exact: true }).click();
  await page.getByLabel('作品来源会话', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('作品来源会话', { exact: true }).inputValue(), session.id);
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: /^作品/ }).click();
  assert.equal(await page.getByRole('tab', { name: '资料整理', exact: true }).count(), 0);
  assert.equal(
    await page.locator('.sidebar-rail').getByRole('button', { name: '作品', exact: true }).count(),
    0,
  );
  await page
    .locator('.artifact-entry')
    .filter({ hasText: '整理结果.md' })
    .getByRole('button', { name: '整理', exact: true })
    .click();
  await page.getByLabel('整理要求', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('整理要求', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '使用整理提示词', exact: true }).click();
  assert.match(await page.getByLabel('整理要求', { exact: true }).inputValue(), /会话历史/);
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
  assert.equal(await page.locator('.artifact-day').count(), 1);
  const dateToggle = page.locator('.artifact-day-toggle').first();
  await dateToggle.click();
  assert.equal(await dateToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.artifact-grid').first().isVisible(), false);
  await page.getByRole('tab', { name: /^创作/ }).click();
  await page.getByRole('tab', { name: /^作品/ }).click();
  await page.locator('.artifact-day-toggle').first().waitFor();
  assert.equal(await dateToggle.getAttribute('aria-expanded'), 'false');
  await dateToggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await dateToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('.artifact-grid').first().isVisible(), true);
  await page.getByLabel('作品日期', { exact: true }).fill('2000-01-01');
  await page.getByText('没有匹配的作品', { exact: true }).waitFor();
  await page.getByRole('button', { name: '全部日期', exact: true }).click();
  await waitFor(
    page,
    () => document.querySelectorAll('.artifact-grid .artifact-card').length === 2,
  );
  await page.getByLabel('作品类型', { exact: true }).selectOption('image');
  await waitFor(
    page,
    () => document.querySelectorAll('.artifact-grid .artifact-card').length === 1,
  );
  await page.getByLabel('作品类型', { exact: true }).selectOption('');
  await waitFor(
    page,
    () => document.querySelectorAll('.artifact-grid .artifact-card').length === 2,
  );
  for (const [width, height] of [
    [1440, 1000],
    [900, 650],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      const bounds = await page
        .locator('.sidebar-rail')
        .getByRole('button', { name: '设置', exact: true })
        .evaluate((button) => {
          const b = button.getBoundingClientRect();
          return {
            bottom: b.bottom,
            height: innerHeight,
            overflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
      assert.ok(bounds.bottom <= bounds.height + 1);
      assert.ok(bounds.overflow <= 1);
      await page.screenshot({ path: path.join(root, `works-${width}-${theme}.png`) });
    }
  }
  await app.close();
  page = await launch();
  assert.equal((await page.evaluate(() => window.tongzhou.artifactList())).total, 2);
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: /^作品/ }).click();
  await page.getByRole('button', { name: '查看作品 测试图片.png', exact: true }).click();
  await page.getByRole('button', { name: '删除作品', exact: true }).click();
  await page.getByRole('button', { name: '确认删除作品', exact: true }).click();
  await waitFor(page, async () => (await window.tongzhou.artifactList()).total === 1);
  assert.equal(
    (await page.evaluate(() => window.tongzhou.contentState('default'))).documents.length,
    1,
  );
  assert.equal(
    (await page.evaluate((id) => window.tongzhou.messages(id), session.id)).filter(
      (m) => m.role === 'user',
    ).length,
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS artifacts: generation, cards, scope, preview, export, organize, explicit library save, navigation, layouts and restart. ' +
      root,
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(root, 'failure.png') });
  }
  throw error;
} finally {
  if (app) await app.close();
  server.close();
}
