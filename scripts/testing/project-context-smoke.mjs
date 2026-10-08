import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/project-context-'));
const repo = path.join(root, '示例项目');
await mkdir(path.join(repo, 'src'), { recursive: true });
const original = 'export const count = 1;\nexport function greet() {\n  return "hello";\n}\n';
await writeFile(path.join(repo, 'src', 'hello.ts'), original);
const readme = [
  '# 示例项目',
  '',
  '项目功能回归。' + '这是一段需要在窄侧栏中自动换行的说明。'.repeat(12),
  '',
  '## Getting Started',
  '',
  '- 安装依赖',
  '- 启动开发服务',
  '',
  '> 仅在本地运行。',
  '',
  '```bash',
  'npm run dev',
  'echo ' + 'long-command-'.repeat(40),
  '```',
  '',
  '| 名称 | 状态 | 长字段 |',
  '| --- | --- | --- |',
  '| demo | 可用 | ' + '字段'.repeat(50) + ' |',
  '',
  '[开发指南](./docs/guide.md)',
  '',
  '<script>window.untrustedDocument = true</script>',
].join('\n');
await writeFile(path.join(repo, 'README.md'), readme);
await mkdir(path.join(repo, 'docs'));
await writeFile(
  path.join(repo, 'docs/guide.md'),
  '# 开发指南\n\n[返回 README](../README.md)\n\n[定位源码行](../README.md#L3)\n',
);
const git = (args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
git(['init', '-b', 'main']);
git(['config', 'user.name', 'Fixture']);
git(['config', 'user.email', 'fixture@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);
await writeFile(path.join(repo, 'src', 'hello.ts'), original.replace('= 1', '= 2'));
git(['add', '.']);
await writeFile(path.join(repo, 'src', 'hello.ts'), original.replace('= 1', '= 3'));
await writeFile(path.join(repo, '新文件.ts'), 'export const added = true;\n');
await build({
  entryPoints: ['electron/services/storage/store.ts'],
  outfile: path.join(root, 'store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { Store } = createRequire(import.meta.url)(path.join(root, 'store.cjs'));
const store = new Store(path.join(root, 'profile/tongzhou.db'), {
  encrypt: (s) => s,
  decrypt: (s) => s,
});
store.put('project', {
  id: 'context-fixture',
  name: '项目面板回归',
  path: repo,
  createdAt: Date.now(),
});
const session = store.createSession('context-fixture');
store.put('session', { ...session, title: '项目面板回归会话' });
store.close();
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
const checks = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
  );
  await page.waitForSelector('.app-shell');
  await page.locator(`[data-session-id="${session.id}"]`).click();
  if (await page.getByLabel('展开工作区', { exact: true }).count())
    await page.getByLabel('展开工作区', { exact: true }).click();
  const panel = page.getByLabel('项目上下文', { exact: true });
  await panel.getByRole('button', { name: 'README.md', exact: true }).click();
  const preview = panel.getByRole('region', { name: 'Markdown 预览', exact: true });
  await preview.getByRole('heading', { name: '示例项目', exact: true }).waitFor();
  assert.equal(
    await preview.getByRole('heading', { name: 'Getting Started', exact: true }).count(),
    1,
  );
  assert.equal(await preview.locator('li').count(), 2);
  assert.equal(await preview.locator('table tbody tr').count(), 1);
  assert.equal(await preview.locator('blockquote').count(), 1);
  assert.match(await preview.locator('.code-block pre').innerText(), /npm run dev/);
  assert.equal(await panel.getByLabel('文件源码', { exact: true }).count(), 0);
  const fit = async () => {
    const layout = await panel.evaluate((e) => {
      const body = e.querySelector('.project-panel-body');
      const doc = e.querySelector('.project-document');
      const code = doc.querySelector('.code-block pre');
      return {
        outer: body.scrollWidth <= body.clientWidth + 1,
        document: doc.getBoundingClientRect().right <= e.getBoundingClientRect().right + 1,
        codeScroll: code.scrollWidth > code.clientWidth,
      };
    });
    assert.ok(layout.outer, 'the side panel must not scroll horizontally');
    assert.ok(layout.document, 'rendered document fits the side panel');
    assert.ok(layout.codeScroll, 'long code scrolls inside its own block');
  };
  await fit();
  assert.equal(await page.evaluate(() => window.untrustedDocument), undefined);
  await page.screenshot({ path: path.join(root, 'markdown-preview-light.png') });
  await panel.getByRole('tab', { name: '源码', exact: true }).click();
  await panel.getByLabel('文件源码', { exact: true }).waitFor();
  assert.equal(
    await panel.getByRole('button', { name: '换行', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(
    await panel.locator('.project-source').evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    true,
  );
  await panel.getByRole('button', { name: '换行', exact: true }).click();
  assert.equal(
    await panel.locator('.project-source').evaluate((e) => e.scrollWidth > e.clientWidth),
    true,
  );
  await panel.getByRole('button', { name: '换行', exact: true }).click();
  await panel.getByLabel('选择第 3 行', { exact: true }).click();
  await panel.getByRole('tab', { name: '预览', exact: true }).click();
  await panel.getByLabel('引用文件到会话', { exact: true }).click();
  assert.doesNotMatch(await page.getByLabel('消息', { exact: true }).inputValue(), /第 3 行/);
  await page.getByLabel('消息', { exact: true }).fill('');
  await preview.getByRole('button', { name: '开发指南', exact: true }).click();
  await preview.getByRole('heading', { name: '开发指南', exact: true }).waitFor();
  await preview.getByRole('button', { name: '返回 README', exact: true }).click();
  await preview.getByRole('heading', { name: '示例项目', exact: true }).waitFor();
  await preview.getByRole('button', { name: '开发指南', exact: true }).click();
  await preview.getByRole('button', { name: '定位源码行', exact: true }).click();
  await panel.locator('.source-line.selected').waitFor();
  assert.equal(
    await panel.getByRole('tab', { name: '源码', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await panel.getByRole('tab', { name: '预览', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 760),
  );
  await page.evaluate(() =>
    window.tongzhou.setAppearance({
      theme: 'dark',
      style: 'graphite',
      font: 'system',
      textSize: 14,
    }),
  );
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await fit();
  await page.screenshot({ path: path.join(root, 'markdown-preview-narrow-dark.png') });
  await page.reload();
  await preview.getByRole('heading', { name: '示例项目', exact: true }).waitFor();
  await fit();
  checks.push(
    'Markdown renders headings, lists, quotes, table and code; narrow document fit, inner code scroll, preview/source switch, source wrapping, relative links and exact line navigation, reload persistence, untrusted HTML ignored',
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
  );
  await panel.getByLabel('返回文件列表', { exact: true }).click();
  await panel.getByRole('button', { name: 'src', exact: true }).click();
  await panel.getByRole('button', { name: 'hello.ts', exact: true }).click();
  await panel.locator('.hljs-keyword').first().waitFor();
  assert.equal(await panel.locator('.source-line').count(), 5);
  await page.getByLabel('消息', { exact: true }).fill('保留原来的要求');
  await panel.getByLabel('选择第 2 行', { exact: true }).click();
  await panel.getByLabel('引用文件到会话', { exact: true }).click();
  const draft = await page.getByLabel('消息', { exact: true }).inputValue();
  assert.match(draft, /保留原来的要求/);
  assert.match(draft, /hello\.ts/);
  assert.match(draft, /第 2 行/);
  checks.push(
    'source highlighting, numbered lines, reference preserves draft and targets current session',
  );
  await panel.getByLabel('返回文件列表', { exact: true }).click();
  await panel.getByLabel('搜索项目文件', { exact: true }).fill('新文件');
  await panel.locator('.search-result').filter({ hasText: '新文件.ts' }).waitFor();
  await panel.getByLabel('项目搜索方式', { exact: true }).selectOption('content');
  await panel.getByLabel('搜索项目文件', { exact: true }).fill('greet');
  await panel.locator('.search-result').filter({ hasText: 'hello.ts:2' }).click();
  await panel.locator('.source-line.selected').waitFor();
  checks.push('path/content search and result line navigation');
  await page.getByRole('tab', { name: '审阅', exact: true }).click();
  await page.getByRole('button', { name: '工作目录全部改动', exact: true }).click();
  await panel
    .locator('.project-change-list')
    .getByRole('button', { name: /新文件/ })
    .click();
  await panel.locator('.diff-line.add').filter({ hasText: 'added = true' }).waitFor();
  await panel
    .locator('.project-change-list')
    .getByRole('button', { name: /hello.ts/ })
    .click();
  await panel.locator('.diff-line.remove').filter({ hasText: 'count = 2' }).waitFor();
  await panel.locator('.diff-line.add').filter({ hasText: 'count = 3' }).waitFor();
  await panel.getByLabel('选择新版本第 1 行', { exact: true }).click();
  await panel.getByLabel('反馈此处变更', { exact: true }).click();
  assert.match(await page.getByLabel('消息', { exact: true }).inputValue(), /新版本第 1 行/);
  await panel.getByLabel('变更范围', { exact: true }).selectOption('staged');
  await panel
    .locator('.project-change-list')
    .getByRole('button', { name: /hello.ts/ })
    .click();
  await panel.locator('.diff-line.add').filter({ hasText: 'count = 2' }).waitFor();
  await panel.getByRole('button', { name: '请同舟审阅', exact: true }).click();
  assert.match(await page.getByLabel('消息', { exact: true }).inputValue(), /已暂存.*Git 变更/);
  checks.push('new files, staged/unstaged diffs, old/new line references, review prompt');
  await page.screenshot({ path: 'test-results/project-context-changes.png' });
  await page
    .getByRole('tablist', { name: '工作区工具' })
    .getByRole('tab', { name: '文件', exact: true })
    .click();
  await panel.getByRole('tab', { name: '说明', exact: true }).click();
  await panel.getByRole('button', { name: '生成基础说明', exact: true }).click();
  await panel.locator('.project-preview-bar').filter({ hasText: 'agent.md' }).waitFor();
  const instructions = await readFile(path.join(repo, 'agent.md'), 'utf8');
  await panel.getByLabel('返回文件列表', { exact: true }).click();
  await panel.getByRole('button', { name: '查看 Agent 说明', exact: true }).click();
  await panel.locator('.project-preview-bar').filter({ hasText: 'agent.md' }).waitFor();
  assert.equal(await readFile(path.join(repo, 'agent.md'), 'utf8'), instructions);
  checks.push('initialization opens instructions, repeated action does not overwrite');
  await panel.getByRole('tab', { name: '文件', exact: true }).click();
  await panel.getByLabel('搜索项目文件', { exact: true }).fill('');
  await panel.getByRole('button', { name: 'hello.ts', exact: true }).click();
  await panel.locator('.hljs-keyword').first().waitFor();
  await page.getByLabel('放大工作区', { exact: true }).click();
  await page.screenshot({ path: 'test-results/project-context-files.png' });
  await page.evaluate(() =>
    window.tongzhou.setAppearance({
      theme: 'dark',
      style: 'graphite',
      font: 'system',
      textSize: 14,
    }),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 760),
  );
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/project-context-dark.png' });
  assert.equal(
    await panel.evaluate(
      (e) => e.getBoundingClientRect().right <= innerWidth && e.getBoundingClientRect().left >= 0,
    ),
    true,
  );
  await page.getByLabel('关闭工作区', { exact: true }).click();
  assert.equal(await page.getByLabel('项目上下文', { exact: true }).count(), 0);
  checks.push('wide panel, dark mode, narrow window layout, close');
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/project-context-report.json',
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (e) {
  await (await app.firstWindow())
    .screenshot({ path: 'test-results/project-context-failure.png' })
    .catch(() => {});
  throw e;
} finally {
  await app.close();
}
