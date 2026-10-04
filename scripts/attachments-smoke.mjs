import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/attachments-'));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const requests = [];
const longText = '长文本附件的完整内容。\n'.repeat(500) + '文件末尾必须保留';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const b of req) raw += b;
  const body = JSON.parse(raw);
  requests.push(body);
  const user = body.messages.filter((m) => m.role === 'user').at(-1);
  const needsText = typeof user.content === 'string' && user.content.includes('text/plain');
  const result =
    needsText && body.messages.at(-1).role !== 'tool'
      ? {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'read-paste',
                function: {
                  name: 'read_attachment',
                  arguments: JSON.stringify({
                    attachmentId: user.content.match(/attachmentId=([\da-f-]+)/)[1],
                    limit: 16000,
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        }
      : {
          delta: { content: needsText ? '文本附件读取完成' : '图片请求已接收' },
          finish_reason: 'stop',
        };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify({ choices: [result] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.welcome');
  await app.evaluate(async ({ BrowserWindow, clipboard, ClipboardItem }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1200, 850);
    globalThis.attachmentClipboard = await Promise.all(
      (await clipboard.read()).map(
        async (item) =>
          new ClipboardItem(
            Object.fromEntries(
              await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
            ),
          ),
      ),
    );
  });
  await page.evaluate(
    async (base) =>
      window.tongzhou.saveProvider({
        id: 'attachment-fixture',
        name: '附件测试',
        protocol: 'openai-chat',
        baseUrl: base,
        auth: 'none',
        models: ['vision'],
        maxOutputTokens: 1024,
        contextChars: 0,
      }),
    `http://127.0.0.1:${server.address().port}/v1`,
  );
  await page.getByLabel('当前连接', { exact: true }).selectOption('attachment-fixture');
  await page.getByLabel('消息', { exact: true }).focus();
  await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    clipboard.clear();
    const bitmap = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), {
      width: 1,
      height: 1,
    });
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([bitmap.toPNG()], { type: 'image/png' }),
      }),
    ]);
  }, png.toString('base64'));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await page.locator('.composer .attachment-card').waitFor();
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '');
  await page
    .getByLabel('选择附件文件')
    .setInputFiles({ name: 'uploaded.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(
    () => document.querySelectorAll('.composer .attachment-card').length === 2,
  );
  await page.locator('.composer .attachment-open').last().click();
  await page.locator('.attachment-dialog img').waitFor();
  await page.getByRole('button', { name: '关闭附件预览' }).click();
  await page.reload();
  await page.waitForSelector('.welcome');
  assert.equal(
    await page.locator('.composer .attachment-card').count(),
    2,
    'Attachment draft survives reload',
  );
  await page.getByLabel('当前连接', { exact: true }).selectOption('attachment-fixture');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('图片请求已接收', { exact: true }).waitFor();
  assert.equal(
    requests[0].messages
      .find((m) => m.role === 'user')
      .content.filter((c) => c.type === 'image_url').length,
    2,
  );
  const pastedData = Buffer.from(
    requests[0].messages
      .find((m) => m.role === 'user')
      .content.find((c) => c.type === 'image_url')
      .image_url.url.split(',')[1],
    'base64',
  );
  assert.equal(pastedData.readUInt32BE(16), 1, 'Pasted image must be our synthetic 1px image');
  assert.equal(pastedData.readUInt32BE(20), 1);
  assert.equal(await page.locator('.composer .attachment-card').count(), 0);
  assert.equal(await page.locator('.chat-message.user .attachment-card').count(), 2);
  await page.getByLabel('消息', { exact: true }).focus();
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), longText);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await page.locator('.composer .attachment-card.is-text').waitFor();
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '');
  await page.locator('.composer .attachment-open').click();
  await page.locator('.attachment-dialog pre').waitFor();
  assert.equal(await page.locator('.attachment-dialog pre').innerText(), longText);
  await page.getByRole('button', { name: '关闭附件预览' }).click();
  await page.screenshot({ path: 'test-results/attachments-composer.png' });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('文本附件读取完成', { exact: true }).waitFor();
  assert.ok(
    !JSON.stringify(requests[1]).includes('文件末尾必须保留'),
    'Large paste is not expanded in initial prompt',
  );
  assert.ok(
    requests
      .at(-1)
      .messages.some((m) => m.role === 'tool' && m.content.includes('文件末尾必须保留')),
    'Reader receives complete file',
  );
  await page.reload();
  await page.waitForSelector('.welcome');
  await page.locator('[data-session-id]').first().click();
  await page.locator('.chat-message.user .attachment-card.is-text').waitFor();
  await page.locator('.chat-message.user .attachment-card.is-text .attachment-open').click();
  await page.locator('.attachment-dialog pre').waitFor();
  assert.equal(await page.locator('.attachment-dialog pre').innerText(), longText);
  await page.getByRole('button', { name: '关闭附件预览' }).click();
  await page
    .getByLabel('选择附件文件')
    .setInputFiles({ name: 'remove.txt', mimeType: 'text/plain', buffer: Buffer.from('可以移除') });
  await page.getByRole('button', { name: '移除附件 remove.txt' }).click();
  assert.equal(await page.locator('.composer .attachment-card').count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test-results/attachments-history.png' });
  await writeFile(
    'test-results/attachments-report.json',
    JSON.stringify(
      {
        passed: true,
        requests: requests.length,
        checks: [
          'clipboard image',
          'upload image',
          'image-only send',
          'two real image payloads',
          'draft reload',
          'long paste to file',
          'full text read through tool',
          'history preview after reload',
          'remove attachment',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Attachments smoke passed: clipboard/upload images, drafts, model image payloads, full pasted file via tool and persistent previews.',
  );
} catch (error) {
  await (await app.firstWindow())
    .screenshot({ path: 'test-results/attachments-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  await app
    .evaluate(({ clipboard }) => {
      if (globalThis.attachmentClipboard) return clipboard.write(globalThis.attachmentClipboard);
    })
    .catch(() => {});
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
