import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
if (process.env.TONGZHOU_COMPUTER_SMOKE !== '1')
  throw new Error(
    'Set TONGZHOU_COMPUTER_SMOKE=1. This test operates only its own isolated fixture window.',
  );
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/computer-'));
await writeFile(
  path.join(root, 'fixture.html'),
  `<html><head><title>同舟电脑控制测试</title><meta charset="utf-8"></head><body><h1>同舟电脑控制测试</h1><input autofocus id="sample" style="font-size:24px"/><p>此窗口仅供自动化测试，输入不会发送到外部服务。</p><button id="click-test" onclick="this.textContent=confirm('同舟独立测试确认框，请取消')?'已确认':'已取消'">验证点击</button></body></html>`,
);
let stage = 0,
  frame,
  windowId,
  windowBounds,
  frameSize;
const outcomes = [];
const waitingPointers = [];
let inspectPointer;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const b of req) raw += b;
  const body = JSON.parse(raw);
  if (stage > 0 && inspectPointer) {
    // Simulate a model thinking pause longer than the old 700 ms expiry.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    waitingPointers.push(await inspectPointer());
  }
  const result = body.messages.filter((m) => m.role === 'tool').at(-1);
  if (
    result &&
    (result.content.startsWith('[工具未完成]') ||
      result.content.startsWith('Error:') ||
      result.content.startsWith('SyntaxError:'))
  ) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [
            { delta: { content: '电脑测试失败：' + result.content }, finish_reason: 'stop' },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    return;
  }
  if (result && stage > 0) {
    outcomes.push(result.content);
    if (result.content.includes('frameId')) {
      const data = JSON.parse(result.content);
      frame = data.frameId;
      frameSize = data;
      windowBounds = data.captureBounds ?? windowBounds;
    }
    if (stage === 1) {
      const windows = JSON.parse(result.content);
      const target = windows.find((w) => w.title === '同舟电脑控制测试');
      windowId = target?.id;
      windowBounds = target?.bounds;
    }
  }
  const actions = [
    ['computer_windows', {}],
    ['computer_screenshot', { windowId }],
    ['computer_type', { frameId: frame, text: '同舟输入测试' }],
    ['computer_screenshot', { windowId }],
    ['computer_key', { frameId: frame, key: 'CTRL+A' }],
    ['computer_screenshot', { windowId }],
    ['computer_type', { frameId: frame, text: '验证完成' }],
    ['computer_screenshot', { windowId }],
    [
      'computer_click',
      {
        frameId: frame,
        x: frameSize ? frameSize.width * 0.06 : 0,
        y: frameSize ? frameSize.height * 0.56 : 0,
      },
    ],
    ['computer_screenshot', { windowId }],
    ['computer_key', { frameId: frame, key: 'ESC' }],
    ['computer_screenshot', { windowId }],
  ];
  const action = actions[stage++];
  const response = action
    ? {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'computer-' + stage,
                  function: { name: action[0], arguments: JSON.stringify(action[1]) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }
    : { choices: [{ delta: { content: '电脑控制测试结束' }, finish_reason: 'stop' }] };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify(response) + '\n\ndata: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch(
  executablePath
    ? { executablePath: path.resolve(executablePath), args: [], cwd: root, env }
    : { args: ['.'], env },
);
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  inspectPointer = () =>
    app.evaluate(({ BrowserWindow }) => {
      const pointer = BrowserWindow.getAllWindows().find((w) => w.getTitle() === '同舟操作指针');
      return !!pointer && pointer.isVisible() && !pointer.isFocusable();
    });
  await app.evaluate(({ app }) => {
    globalThis.pointerObservations = [];
    app.on('browser-window-created', (_event, window) => {
      if (window.getTitle() !== '同舟操作指针') return;
      window.once('show', () =>
        globalThis.pointerObservations.push({
          focusable: window.isFocusable(),
          onTop: window.isAlwaysOnTop(),
          focused: window.isFocused(),
        }),
      );
    });
  });
  await app.evaluate(
    async ({ BrowserWindow }, file) => {
      const fixture = new BrowserWindow({
        width: 720,
        height: 400,
        title: '同舟电脑控制测试',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      await fixture.loadFile(file);
    },
    path.join(root, 'fixture.html'),
  );
  const target = (await app.windows()).find((w) => w !== page);
  await target.locator('#sample').waitFor();
  await page.evaluate(async (base) => {
    await window.tongzhou.saveProvider({
      id: 'computer-fixture',
      name: '电脑测试',
      protocol: 'openai-chat',
      baseUrl: base,
      auth: 'none',
      models: ['fixture'],
      contextChars: 100000,
      maxOutputTokens: 1000,
    });
    await window.tongzhou.setCapability('computer', true);
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('当前连接', { exact: true }).selectOption('computer-fixture');
  await page
    .getByLabel('消息', { exact: true })
    .fill('仅操作同舟电脑控制测试窗口，验证中文输入和快捷键');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  for (let i = 0; i < 12; i++) {
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    const approval = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: '批准本次', exact: true }) });
    await Promise.race([
      approval.waitFor({ timeout: 45000 }),
      page
        .getByText(/^电脑测试失败：/)
        .waitFor({ timeout: 45000 })
        .then(async () => {
          throw new Error((await page.getByText(/^电脑测试失败：/).innerText()).slice(0, 1200));
        }),
    ]);
    await approval.getByRole('button', { name: '批准本次', exact: true }).click();
    await approval.waitFor({ state: 'hidden' });
  }
  await page.getByText('电脑控制测试结束', { exact: true }).waitFor({ timeout: 45000 });
  assert.equal(await target.locator('#sample').inputValue(), '验证完成');
  assert.equal(await target.locator('#click-test').innerText(), '已取消');
  assert.ok(
    outcomes.some((v) => v.includes('requestedWindowId')),
    'Owned modal should be captured explicitly',
  );
  assert.ok(outcomes.filter((v) => v.includes('frameId')).length >= 3);
  const pointers = await app.evaluate(() => globalThis.pointerObservations);
  assert.equal(pointers.length, 1, 'Reuse one pointer window throughout the run');
  assert.ok(
    waitingPointers.length >= 12 && waitingPointers.every(Boolean),
    'Pointer must remain visible during every model thinking gap',
  );
  await page.waitForFunction(() => !document.querySelector('[aria-label="停止生成"]'));
  assert.equal(await inspectPointer(), false, 'Pointer must be removed when the run ends');
  assert.ok(
    pointers.every((p) => !p.focusable && !p.focused && p.onTop),
    'Pointer must be non-focusing and on top: ' + JSON.stringify(pointers),
  );
  await page.screenshot({ path: 'test-results/14-computer.png' });
  await target.screenshot({ path: 'test-results/15-computer-fixture.png' });
  console.log(
    'Computer smoke passed: native window discovery, real screenshots, Chinese Unicode input, focus, Ctrl+A and screenshot-coordinate click on the isolated fixture window. No external model calls.',
  );
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
