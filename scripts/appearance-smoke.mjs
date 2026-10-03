import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/appearance-'));
await build({
  entryPoints: ['electron/store.ts'],
  outfile: path.join(root, 'store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { Store } = createRequire(import.meta.url)(path.join(root, 'store.cjs'));
const store = new Store(path.join(root, 'profile/tongzhou.db'), {
  encrypt: (v) => v,
  decrypt: (v) => v,
});
const session = store.createSession();
store.put('session', { ...session, title: '把想法变成作品' });
store.message({
  id: 'user',
  sessionId: session.id,
  role: 'user',
  content: '帮我理清一下，这个功能应该怎么做？',
  createdAt: 1000,
  status: 'complete',
});
store.message({
  id: 'assistant',
  sessionId: session.id,
  role: 'assistant',
  content:
    '可以先从一个简单、完整的流程开始。\n\n把**需要解决的问题**写清楚，再确定用户完成任务的步骤：\n\n- 进入会话，描述想法\n- 查看结果，随时补充要求\n- 完成验证，保留每次修改\n\n```ts\nconst workspace = "同舟";\nconsole.log("Ready to build.");\n```\n\n先让核心流程顺畅，再逐步补充其他能力。',
  createdAt: 2000,
  status: 'complete',
});
store.close();
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const launch = () => electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
let app = await launch();
const errors = [],
  fonts = [],
  screens = [];
const prepare = async () => {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(10000);
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setIgnoreMouseEvents(true);
    w.setContentSize(1440, 900);
  });
  return page;
};
try {
  let page = await prepare();
  const nav = (label) =>
    page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
  const capture = async (name) => {
    const file = 'test-results/appearance-' + name + '.png';
    await page.screenshot({ path: file, animations: 'disabled' });
    screens.push(file);
    assert.equal(
      await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '.page,.modal,.conversation,.appearance-card,.appearance-preview',
          ),
        ]
          .filter((e) => e.getClientRects().length)
          .some((e) => e.scrollWidth > e.clientWidth + 2),
      ),
      false,
      'overflow: ' + name,
    );
  };
  assert.equal(await page.getByRole('button', { name: '项目与工作树', exact: true }).count(), 0);
  await page.evaluate(() => {
    localStorage.removeItem('tongzhou-appearance');
    localStorage.setItem('tongzhou-theme', 'dark');
  });
  await page.reload();
  await page.waitForSelector('.welcome');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await nav('设置与优化');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  for (const font of ['modern', 'system', 'serif']) {
    await page.getByLabel('界面字体', { exact: true }).selectOption(font);
    await page.evaluate(() => document.fonts.ready);
    const { root: documentNode } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: documentNode.nodeId,
      selector: '.preview-body > p',
    });
    const result = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    fonts.push({ font, fonts: result.fonts });
    assert.equal(await page.locator('html').getAttribute('data-font'), font);
    assert.match(
      await page.locator('.preview-body code').evaluate((el) => getComputedStyle(el).fontFamily),
      /Consolas|Cascadia|SFMono/,
    );
  }
  await page.getByLabel('界面字体', { exact: true }).selectOption('modern');
  await page.getByLabel('聊天字号', { exact: true }).selectOption('18');
  assert.equal(
    await page.locator('.preview-body > p').evaluate((el) => getComputedStyle(el).fontSize),
    '18px',
  );
  for (const style of ['石墨', '雾蓝', '暖砂']) {
    for (const theme of ['浅色', '深色']) {
      await nav('设置与优化');
      await page.getByRole('button', { name: style, exact: true }).click();
      await page.getByRole('button', { name: theme, exact: true }).click();
      await page.locator('.settings-page').evaluate((el) => (el.scrollTop = 0));
      const contrast = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        const luminance = (color) => {
          const c = color.trim().replace('#', '');
          const channels = [0, 2, 4]
            .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
            .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const ratio = (a, b) => {
          const x = luminance(css.getPropertyValue(a)),
            y = luminance(css.getPropertyValue(b));
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        return [
          ratio('--ink', '--canvas'),
          ratio('--muted', '--surface'),
          ratio('--on-accent', '--accent'),
        ];
      });
      assert.ok(
        contrast.every((n) => n >= 4.5),
        'insufficient text contrast: ' + style + theme + JSON.stringify(contrast),
      );
      await capture(style + '-' + theme + '-settings');
      await page.locator('[data-session-id="' + session.id + '"]').click();
      await page.locator('.markdown').first().waitFor();
      assert.equal(
        await page
          .locator('.markdown')
          .last()
          .evaluate((el) => getComputedStyle(el).fontSize),
        '18px',
      );
      await capture(style + '-' + theme + '-chat');
    }
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 700),
  );
  await nav('设置与优化');
  await page.getByLabel('界面字体', { exact: true }).selectOption('serif');
  await capture('narrow-serif-large');
  await page.getByRole('button', { name: '雾蓝', exact: true }).click();
  await page.getByLabel('聊天字号', { exact: true }).selectOption('14');
  await app.close();
  app = await launch();
  page = await prepare();
  assert.equal(await page.locator('html').getAttribute('data-style'), 'blue');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('html').getAttribute('data-font'), 'serif');
  await nav('设置与优化');
  assert.equal(await page.getByLabel('聊天字号', { exact: true }).inputValue(), '14');
  await page.getByRole('button', { name: '恢复默认外观', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-style'), 'graphite');
  assert.equal(await page.locator('html').getAttribute('data-font'), 'modern');
  assert.equal(await page.getByLabel('聊天字号', { exact: true }).inputValue(), '16');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('.settings-page').evaluate((el) => (el.scrollTop = 0));
  await capture('default-settings');
  await page.locator('[data-session-id="' + session.id + '"]').click();
  await page.locator('.markdown').first().waitFor();
  await capture('default-chat');
  await page.evaluate(() => localStorage.setItem('tongzhou-appearance', '{invalid'));
  await page.reload();
  await page.waitForSelector('.welcome');
  assert.equal(await page.locator('html').getAttribute('data-style'), 'graphite');
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/appearance-report.json',
    JSON.stringify({ passed: true, packaged: !!executablePath, fonts, screens }, null, 2),
  );
  console.log(
    'Appearance smoke passed: six palettes, contrast, real fonts, size, legacy migration, process restart, reset and system changes.',
  );
  console.log(JSON.stringify(fonts));
} catch (e) {
  await app
    .windows()[0]
    ?.screenshot({ path: 'test-results/appearance-failure.png' })
    .catch(() => {});
  throw e;
} finally {
  await app.close();
}
