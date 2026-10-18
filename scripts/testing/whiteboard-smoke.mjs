import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openCanvas, openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/whiteboard-'));
const requests = [];
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const start = body.messages.findLastIndex((m) => m.role === 'user');
    const prompt = String(body.messages[start].content);
    const results = body.messages.slice(start + 1).filter((m) => m.role === 'tool');
    let delta;
    const call = (name, args) => ({
      tool_calls: [
        {
          index: 0,
          id: name + results.length,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    if (!results.length) delta = call('whiteboard_read', {});
    else if (results.length === 1) {
      const scene = JSON.parse(results[0].content);
      assert(scene.version, results[0].content);
      const ops = prompt.includes('调整选中')
        ? [
            {
              type: 'update',
              id: scene.selectedElementIds[0],
              patch: { backgroundColor: '#d3f9d8', text: '已修改' },
            },
          ]
        : [
            {
              type: 'add',
              element: {
                id: 'login',
                type: 'rectangle',
                x: 400,
                y: 100,
                width: 180,
                height: 90,
                text: '输入账号',
              },
            },
            {
              type: 'add',
              element: {
                id: 'check',
                type: 'diamond',
                x: 690,
                y: 80,
                width: 190,
                height: 130,
                text: '验证通过？',
              },
            },
            {
              type: 'add',
              element: {
                id: 'success',
                type: 'rectangle',
                x: 990,
                y: 100,
                width: 180,
                height: 90,
                text: '进入主页',
              },
            },
            { type: 'connect', id: 'edge-a', from: 'login', to: 'check' },
            { type: 'connect', id: 'edge-b', from: 'check', to: 'success', text: '是' },
            { type: 'select', ids: ['login'] },
          ];
      delta = call('whiteboard_apply', { version: scene.version, ops });
    } else {
      assert(!results.some((m) => JSON.parse(m.content).error), JSON.stringify(results));
      delta = {
        content: prompt.includes('调整选中') ? '已修改选中的图形。' : '已创建可编辑登录流程图。',
      };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app, page;
try {
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = [],
    consoleErrors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.waitForSelector('.app-shell');
  const sessionId = await page.evaluate(async (baseUrl) => {
    const api = window.tongzhou;
    await api.saveProvider({
      id: 'fixture',
      name: '测试模型',
      protocol: 'openai-chat',
      baseUrl,
      auth: 'none',
      models: ['mock'],
      maxOutputTokens: 3000,
      contextChars: 80000,
    });
    const s = await api.createSession();
    await api.updateSession(s.id, { title: '白板协作', providerId: 'fixture', model: 'mock' });
    await api.setSessionPermission(s.id, 'full-access');
    return s.id;
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await openSidebar(page, '创作');
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  await page.locator('.whiteboard-editor .excalidraw').waitFor();
  await page.locator('.excalidraw .App-menu_top').waitFor();
  assert.equal(await page.locator('.canvas-node-palette').count(), 0);
  const canvasId = await page.getByLabel('选择画布', { exact: true }).inputValue();
  const read = async () =>
    (await page.evaluate((id) => window.tongzhou.canvasState(id), canvasId)).canvas;
  const poll = async (fn) => {
    const until = Date.now() + 25000;
    while (Date.now() < until) {
      if (await fn()) return;
      await page.waitForTimeout(120);
    }
    throw Error('Timed out');
  };
  // Draw a real native rectangle, then type a bound label in it.
  const board = page.locator('.excalidraw canvas.interactive');
  const bounds = await board.boundingBox();
  await board.click({ position: { x: 250, y: 320 } });
  await page.keyboard.press('r');
  await page.mouse.move(bounds.x + 220, bounds.y + 280);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 400, bounds.y + 390, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await poll(async () =>
    (await read()).whiteboard.elements.some((e) => e.type === 'rectangle' && !e.isDeleted),
  );
  const manual = (await read()).whiteboard.elements.find(
    (e) => e.type === 'rectangle' && !e.isDeleted,
  );
  await board.dblclick({ position: { x: 300, y: 330 } });
  await page.keyboard.insertText('手动添加');
  await page.keyboard.press('Escape');
  await poll(async () => (await read()).whiteboard.elements.some((e) => e.text === '手动添加'));
  // Bind a model session and use the existing canvas assistant, through real tool dispatch.
  await page.getByRole('button', { name: '画布设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '画布设置', exact: true });
  await settings.getByLabel('画布会话').selectOption(sessionId);
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '展开画布聊天', exact: true }).click();
  const chat = page.getByRole('region', { name: '画布助手', exact: true });
  await chat.getByLabel('向画布助手提问').fill('画一个登录流程图');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await chat.getByText('已创建可编辑登录流程图。', { exact: true }).waitFor();
  await poll(async () =>
    (await read()).whiteboard.elements.some((e) => e.id === 'login' && !e.isDeleted),
  );
  assert(requests[0].messages.some((m) => String(m.content).includes('# 白板设计')));
  const availableTools = requests[0].tools.map((t) => t.function.name);
  assert(availableTools.includes('whiteboard_apply'));
  assert(!availableTools.includes('canvas_apply'));
  assert(!availableTools.includes('canvas_execute'));
  assert((await read()).whiteboard.elements.some((e) => e.id === manual.id && !e.isDeleted));
  assert((await read()).whiteboard.elements.some((e) => e.text === '手动添加'));
  await page.screenshot({ path: path.join(root, 'ai-diagram.png') });
  // AI changes must participate in Excalidraw's undo/redo history.
  await page.getByRole('button', { name: '收起画布聊天', exact: true }).click();
  await page.locator('.excalidraw .undo-button-container button').click();
  await poll(
    async () => !(await read()).whiteboard.elements.some((e) => e.id === 'login' && !e.isDeleted),
  );
  assert((await read()).whiteboard.elements.some((e) => e.id === manual.id && !e.isDeleted));
  await page.locator('.excalidraw .redo-button-container button').click();
  await poll(async () =>
    (await read()).whiteboard.elements.some((e) => e.id === 'login' && !e.isDeleted),
  );
  // Drag an AI-created shape through Excalidraw itself: a visually aligned free line fails this.
  const beforeDrag = (await read()).whiteboard;
  const login = beforeDrag.elements.find((e) => e.id === 'login');
  const beforeArrow = beforeDrag.elements.find((e) => e.id === 'edge-a');
  const zoom = beforeDrag.appState.zoom.value;
  const px = bounds.x + (login.x + login.width / 2 + beforeDrag.appState.scrollX) * zoom;
  const py = bounds.y + (login.y + login.height / 2 + beforeDrag.appState.scrollY) * zoom;
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 65, py + 45, { steps: 16 });
  await page.mouse.up();
  await poll(
    async () =>
      Math.abs((await read()).whiteboard.elements.find((e) => e.id === 'login').x - login.x) > 30,
  );
  const afterDrag = (await read()).whiteboard;
  const movedArrow = afterDrag.elements.find((e) => e.id === 'edge-a');
  assert.equal(movedArrow.startBinding.elementId, 'login');
  assert.equal(movedArrow.endBinding.elementId, 'check');
  assert.notDeepEqual(
    [movedArrow.x, movedArrow.y, movedArrow.points],
    [beforeArrow.x, beforeArrow.y, beforeArrow.points],
  );
  assert(
    afterDrag.elements.find((e) => e.id === 'login').boundElements.some((b) => b.id === 'edge-a'),
  );
  await page.screenshot({ path: path.join(root, 'bound-arrow-after-drag.png') });
  // Select a manual shape and ask AI to change only that selection.
  await board.click({ position: { x: 220, y: 320 } });
  await poll(async () => (await read()).whiteboard.appState.selectedElementIds[manual.id]);
  await page.getByRole('button', { name: '展开画布聊天', exact: true }).click();
  await chat.getByLabel('向画布助手提问').fill('调整选中图形');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await chat.getByText('已修改选中的图形。', { exact: true }).waitFor();
  await poll(
    async () =>
      (await read()).whiteboard.elements.find((e) => e.id === manual.id)?.backgroundColor ===
      '#d3f9d8',
  );
  await page.getByRole('button', { name: '收起画布聊天', exact: true }).click();
  // Export using the same native IPC as the UI; dialog targets are isolated test files.
  await board.click({ position: { x: 220, y: 320 }, button: 'right' });
  await page.getByText('添加到素材库中', { exact: true }).click();
  await poll(async () => (await read()).whiteboard.libraryItems?.length === 1);
  const imagePath = path.join(root, 'reference.svg');
  await writeFile(
    imagePath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="12" fill="#dbeafe"/><circle cx="80" cy="50" r="24" fill="#2563eb"/></svg>',
  );
  // Electron's File System Access picker is native, so supply its chosen file
  // while exercising Excalidraw's real image import, placement and persistence.
  await page.evaluate(
    (svg) => {
      window.showOpenFilePicker = async () => [
        {
          kind: 'file',
          name: 'reference.svg',
          getFile: async () => new File([svg], 'reference.svg', { type: 'image/svg+xml' }),
        },
      ];
    },
    await readFile(imagePath, 'utf8'),
  );
  await page.getByTestId('toolbar-image').locator('..').click();
  await poll(async () => Object.keys((await read()).whiteboard.files).length > 0);
  // File ingestion precedes image decoding. The native image cursor signals
  // placement readiness; a fixed delay races slower CI renderers.
  await page.waitForFunction(() =>
    document.querySelector('.excalidraw canvas.interactive')?.style.cursor.startsWith('url('),
  );
  const imageBounds = await board.boundingBox();
  await page.mouse.move(imageBounds.x + 550, imageBounds.y + 550);
  await page.mouse.down();
  await page.mouse.move(imageBounds.x + 710, imageBounds.y + 650, { steps: 10 });
  await page.mouse.up();
  await poll(async () =>
    (await read()).whiteboard.elements.some((e) => e.type === 'image' && !e.isDeleted),
  );
  await page.keyboard.press('Escape');
  for (const [format, label] of [
    ['excalidraw', '导出可编辑白板'],
    ['svg', '导出 SVG'],
    ['png', '导出 PNG'],
  ]) {
    const filePath = path.join(root, `diagram.${format}`);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, filePath);
    await page.locator('.excalidraw .main-menu-trigger').click();
    await page.getByText(label, { exact: true }).click();
    await poll(async () => {
      try {
        return (await stat(filePath)).size > 100;
      } catch {
        return false;
      }
    });
  }
  const exported = JSON.parse(await readFile(path.join(root, 'diagram.excalidraw'), 'utf8'));
  assert.equal(exported.type, 'excalidraw');
  assert.equal(exported.libraryItems.length, 1);
  assert(Object.keys(exported.files).length > 0);
  assert(exported.elements.some((e) => e.id === manual.id));
  assert((await readFile(path.join(root, 'diagram.svg'), 'utf8')).includes('<svg'));
  assert.equal((await readFile(path.join(root, 'diagram.png'))).subarray(1, 4).toString(), 'PNG');
  await app.evaluate(
    ({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    },
    path.join(root, 'diagram.excalidraw'),
  );
  await page.getByRole('button', { name: '导入白板', exact: true }).click();
  await poll(
    async () => (await page.getByLabel('选择画布', { exact: true }).inputValue()) !== canvasId,
  );
  const importedId = await page.getByLabel('选择画布', { exact: true }).inputValue();
  assert.equal(
    (await page.evaluate((id) => window.tongzhou.canvasState(id), importedId)).canvas.mode,
    'whiteboard',
  );
  await page.reload();
  await page.waitForSelector('.app-shell');
  await openSidebar(page, '创作');
  await openCanvas(page, canvasId);
  await page.locator('.whiteboard-editor .excalidraw').waitFor();
  await poll(
    async () =>
      (await read()).whiteboard.elements.find((e) => e.id === manual.id)?.backgroundColor ===
      '#d3f9d8',
  );
  await page.screenshot({ path: path.join(root, 'reopened.png') });
  assert.equal((await read()).whiteboard.libraryItems.length, 1);
  await page.waitForTimeout(1800); // Let restored viewport/file metadata finish its initial save.
  const stableVersion = (await read()).version;
  await page.waitForTimeout(1800);
  assert.equal(
    (await read()).version,
    stableVersion,
    'An idle scene must not save its own echo repeatedly',
  );
  await page.evaluate(() =>
    window.tongzhou.setAppearance({
      language: 'en',
      theme: 'dark',
      style: 'graphite',
      font: 'system',
      textSize: 14,
    }),
  );
  await page.getByTitle('New whiteboard', { exact: true }).waitFor();
  await page.locator('.whiteboard-editor .excalidraw.theme--dark').waitFor();
  await poll(
    async () =>
      (await page.getByTestId('toolbar-rectangle').getAttribute('aria-label')) === 'Rectangle',
  );
  await page.screenshot({ path: path.join(root, 'english-dark.png') });
  await writeFile(path.join(root, 'console-errors.json'), JSON.stringify(consoleErrors, null, 2));
  assert.deepEqual(errors, []);
  assert(
    !consoleErrors.some((e) => /Content Security Policy|Failed to fetch|font.*load/i.test(e)),
    consoleErrors.slice(0, 4).join('\n'),
  );
  assert(requests.some((r) => r.tools.some((t) => t.function.name === 'whiteboard_apply')));
  console.log(
    JSON.stringify({
      ok: true,
      root,
      requests: requests.length,
      canvasId,
      checks: [
        'native drawing/text',
        'autosave',
        'AI create/update selection',
        'preserve manual work',
        'undo/redo AI',
        'PNG/SVG/JSON export',
        'native import',
        'reload',
      ],
    }),
  );
} catch (error) {
  if (page)
    console.error(
      'Editor diagnostic',
      await page
        .evaluate(() => {
          const root = document.querySelector('.whiteboard-editor');
          let fiber = root?.[Object.keys(root).find((k) => k.startsWith('__reactFiber'))];
          while (fiber) {
            for (let hook = fiber.memoizedState; hook; hook = hook.next) {
              const value = hook.memoizedState;
              if (value?.getAppState) {
                const s = value.getAppState();
                return {
                  activeTool: s.activeTool,
                  pendingImageElementId: s.pendingImageElementId,
                  newElement: s.newElement,
                  images: value
                    .getSceneElements()
                    .filter((e) => e.type === 'image')
                    .map((e) => ({
                      id: e.id,
                      x: e.x,
                      y: e.y,
                      width: e.width,
                      height: e.height,
                      status: e.status,
                    })),
                  fileIds: Object.keys(value.getFiles()),
                };
              }
            }
            fiber = fiber.return;
          }
        })
        .catch(() => null),
    );
  if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error('Whiteboard test artifacts:', root);
  throw error;
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
}
