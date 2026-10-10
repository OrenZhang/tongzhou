import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/markdown-'));
await build({
  entryPoints: ['electron/services/storage/store.ts'],
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
store.put('session', { ...session, title: '代码与图表' });
const python =
  'def quicksort(arr):\n    # 将数据分成两组，再递归排序\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[len(arr) // 2]\n    left = [x for x in arr if x < pivot]\n    right = [x for x in arr if x > pivot]\n    return quicksort(left) + [pivot] + quicksort(right)\n';
const fence = (language, source, close = true) =>
  '```' + language + '\n' + source + (close ? '\n```' : '');
const rich =
  '# 排序算法与执行流程\n\n代码已完成，下面是实现和验证结果。\n\n' +
  fence('python', python) +
  '\n\n## 验证结果\n\n| 输入 | 输出 | 状态 |\n| --- | --- | --- |\n| 5, 3, 1 | 1, 3, 5 | **通过** |\n\n- [x] 排序正确\n- [ ] 更多边界用例\n\n> 平均时间复杂度为 $O(n \\log n)$。\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n[官方文档](https://example.com/docs)\n\n脚注示例[^note]。\n\n[^note]: 本次验证说明。';
store.message({
  id: 'markdown',
  sessionId: session.id,
  role: 'assistant',
  content: rich,
  createdAt: 2000,
  status: 'complete',
});
store.close();
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const errors = [],
  checks = [],
  externalRequests = [];
const blockedRequests = new Set();
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/^https?:/.test(r.url())) externalRequests.push(r.url());
  });
  page.on('requestfailed', (r) => {
    if (/^(csp|net::ERR_BLOCKED_BY_CSP)$/i.test(r.failure()?.errorText ?? ''))
      blockedRequests.add(r.url());
  });
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow, shell }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setIgnoreMouseEvents(true);
    window.setContentSize(1440, 1000);
    globalThis.openedLinks = [];
    shell.openExternal = async (url) => {
      globalThis.openedLinks.push(url);
    };
  });
  await page.locator('[data-session-id="' + session.id + '"]').click();
  const replace = async (content, status = 'complete') => {
    await app.evaluate(
      ({ BrowserWindow }, message) =>
        BrowserWindow.getAllWindows()[0].webContents.send('tongzhou:event', {
          type: 'message',
          message,
        }),
      {
        id: 'markdown',
        sessionId: session.id,
        role: 'assistant',
        content,
        status,
        createdAt: 2000,
      },
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  const screenshot = async (name) => {
    await page.locator('.feed').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: 'test-results/markdown-' + name + '.png',
      animations: 'disabled',
    });
    assert.equal(
      await page.locator('.conversation').evaluate((el) => el.scrollWidth > el.clientWidth + 2),
      false,
    );
  };
  await page.locator('.hljs-keyword').first().waitFor();
  assert.equal(await page.locator('.markdown h1').innerText(), '排序算法与执行流程');
  assert.equal(await page.locator('.markdown table tbody tr').count(), 1);
  assert.equal(await page.locator('.markdown .task-list-item').count(), 2);
  await page.locator('.katex-display').waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(
      () =>
        [...document.fonts].filter((f) => f.family.startsWith('KaTeX') && f.status === 'error')
          .length,
    ),
    0,
  );
  await page.locator('.code-block').getByRole('button', { name: '复制代码', exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), python + '\n');
  await page.getByRole('link', { name: '官方文档' }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), ['https://example.com/docs']);
  for (const url of ['file:///tmp/x', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    assert.equal(
      await page.evaluate(async (url) => {
        try {
          await window.tongzhou.openExternalLink(url);
          return false;
        } catch {
          return true;
        }
      }, url),
      true,
    );
  }
  const light = await page
    .locator('.hljs-keyword')
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  await screenshot('light');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  const dark = await page
    .locator('.hljs-keyword')
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(light, dark);
  await screenshot('dark');
  checks.push(
    'GFM headings, table, task list, footnote, math/fonts, exact clipboard, validated links, light/dark syntax colors',
  );
  for (const [language, source] of Object.entries({
    javascript: 'const answer = "同舟";',
    typescript: 'interface Result { value: number }',
    json: '{"ok": true}',
    sql: 'SELECT name FROM users;',
    bash: 'echo "$HOME"',
    cpp: 'int main() { return 0; }',
  })) {
    await replace(fence(language, source));
    await page.locator('.code-toolbar > span').filter({ hasText: language }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.code-block code span').length > 0);
  }
  await replace(fence('unfamiliar-language', '<script>alert(1)</script>'));
  assert.equal(await page.locator('.code-block code').innerText(), '<script>alert(1)</script>\n');
  checks.push(
    'Python, JavaScript, TypeScript, JSON, SQL, Bash, C++; unknown languages retain escaped source',
  );
  const diagrams = {
    flowchart:
      'flowchart LR\nA[输入数据] --> B{是否有序?}\nB -->|是| C[返回结果]\nB -->|否| D[执行排序]\nD --> C',
    sequence:
      'sequenceDiagram\nparticipant U as 用户\nparticipant A as 同舟\nU->>A: 处理任务\nA-->>U: 返回结果',
    er: 'erDiagram\nUSER ||--o{ SESSION : owns',
    class: 'classDiagram\nAnimal <|-- Duck\nAnimal : +int age',
    state: 'stateDiagram-v2\n[*] --> Working\nWorking --> Done\nDone --> [*]',
    gantt: 'gantt\ntitle 开发计划\ndateFormat YYYY-MM-DD\nsection 实现\n编码 :a, 2026-10-01, 2d',
    pie: 'pie title 测试结果\n"通过" : 90\n"待处理" : 10',
    mindmap: 'mindmap\n  root((同舟))\n    会话\n    连接\n    工具',
  };
  const waitImage = () =>
    page.waitForFunction(
      () => {
        const image = document.querySelector('.diagram-image');
        return image?.complete && image.naturalWidth > 0;
      },
      { timeout: 20000 },
    );
  for (const [name, source] of Object.entries(diagrams)) {
    const previous = await page.evaluate(() =>
      document.querySelector('.diagram-image')?.getAttribute('src'),
    );
    await replace(fence('mermaid', source));
    await page.waitForFunction((previous) => {
      const image = document.querySelector('.diagram-image');
      return image?.getAttribute('src') && image.getAttribute('src') !== previous;
    }, previous);
    await waitImage();
    await screenshot(name);
    await page.getByRole('button', { name: '源码', exact: true }).click();
    assert.equal(await page.locator('.diagram-block .code-block code').innerText(), source + '\n');
    await page.getByRole('button', { name: '图表', exact: true }).click();
  }
  await page.getByRole('button', { name: '展开图表' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '放大图表' }).click();
  await page.getByRole('dialog').getByText('125%', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  checks.push('8 Mermaid diagram types render locally; source, zoom and expanded preview');
  await replace(fence('', diagrams.flowchart));
  await waitImage();
  checks.push('unlabeled Mermaid grammar renders as a diagram');
  const interactive = `<style>body{font-family:system-ui}button{padding:8px 12px}</style>
<h2>交互测试</h2><button id="counter">点击 0</button><input aria-label="名称" placeholder="输入名称"><p id="output"></p>
<script>let count=0;document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent='点击 '+(++count);document.querySelector('input').oninput=e=>document.querySelector('#output').textContent='你好，'+e.target.value;</script>`;
  await replace(fence('html', interactive, false), 'streaming');
  await page.getByText('交互界面生成中…', { exact: true }).waitFor();
  assert.equal(await page.locator('.html-preview iframe').count(), 0);
  await replace(fence('html', interactive));
  const htmlFrame = () => page.frameLocator('.html-preview iframe');
  await htmlFrame().getByRole('button', { name: '点击 0' }).click();
  await htmlFrame().getByRole('button', { name: '点击 1' }).waitFor();
  await htmlFrame().getByRole('textbox', { name: '名称' }).fill('同舟');
  await htmlFrame().getByText('你好，同舟', { exact: true }).waitFor();
  await page.locator('.html-preview').getByRole('button', { name: '源码', exact: true }).click();
  await page.locator('.html-preview-source').waitFor();
  await page.locator('.html-preview').getByRole('button', { name: '预览', exact: true }).click();
  await htmlFrame().getByRole('button', { name: '点击 1' }).waitFor();
  await page.getByRole('button', { name: '展开预览', exact: true }).click();
  assert.equal(await page.locator('.html-preview.is-expanded').count(), 1);
  await screenshot('html-interactive');
  const isolated = await htmlFrame()
    .locator('body')
    .evaluate(() => {
      let parentBlocked = false;
      try {
        void parent.document.body;
      } catch {
        parentBlocked = true;
      }
      return { parentBlocked, bridge: typeof window.tongzhou, require: typeof window.require };
    });
  assert.deepEqual(isolated, { parentBlocked: true, bridge: 'undefined', require: 'undefined' });
  await page.getByRole('button', { name: '重新运行预览' }).click();
  await htmlFrame().getByRole('button', { name: '点击 0' }).waitFor();
  await replace(
    fence(
      'html',
      '<button id="escape">跳转</button><script>document.querySelector("button").onclick=()=>location.href="https://example.invalid/escape";fetch("https://example.invalid/leak").catch(()=>{});</script><img src="https://example.invalid/pixel">',
    ),
  );
  await htmlFrame().getByRole('button', { name: '跳转' }).click();
  assert.equal(
    page.frames().some((frame) => frame.url().startsWith('https://example.invalid')),
    false,
  );
  await page.getByRole('button', { name: '重新运行预览' }).click();
  await htmlFrame().getByRole('button', { name: '跳转' }).waitFor();
  // Deliberately triggered CSP failures are console messages, not application errors.
  assert.equal(await page.locator('.html-preview iframe').getAttribute('sandbox'), 'allow-scripts');
  checks.push(
    'HTML buttons and inputs, preserved source-toggle state, inline expansion, rerun, streaming gate, isolated parent/Node/IPC, blocked network and navigation',
  );
  assert.equal(
    externalRequests.every((url) => blockedRequests.has(url)),
    true,
  );
  externalRequests.length = 0;
  await replace(fence('mermaid', 'flowchart LR\nA[正在生成', false), 'streaming');
  await page.getByText('图表生成中…', { exact: true }).waitFor();
  assert.equal(await page.locator('.diagram-image').count(), 0);
  await replace(fence('mermaid', diagrams.flowchart), 'complete');
  await waitImage();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await waitImage();
  await screenshot('flowchart-light');
  await replace(fence('mermaid', 'not a diagram'));
  await page.getByText('图表尚未完整或语法不正确，可以查看源码。').waitFor();
  await replace(fence('mermaid', '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B'));
  await page.getByText('图表尚未完整或语法不正确，可以查看源码。').waitFor();
  await replace(
    '<script>window.hacked = true</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://example.invalid/tracking.png)',
  );
  await page.getByText('[图片：remote]', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => !!window.hacked), false);
  assert.equal(await page.locator('.markdown a[href^="javascript:"]').count(), 0);
  assert.deepEqual(externalRequests, []);
  checks.push(
    'streaming incomplete fence, completion, theme redraw, syntax error, configuration injection, HTML/unsafe URL/tracking protection',
  );
  const large = 'const data = "' + 'x'.repeat(100100) + '";';
  await replace(fence('javascript', large));
  await page.locator('.code-block').getByRole('button', { name: '换行', exact: true }).click();
  assert.equal(
    await page.locator('.code-block pre').evaluate((el) => getComputedStyle(el).whiteSpace),
    'pre-wrap',
  );
  await page.locator('.code-block').getByRole('button', { name: '复制代码', exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), large + '\n');
  checks.push('large code stays complete and copyable without expensive highlighting');
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/markdown-report.json',
    JSON.stringify({ passed: true, packaged: !!executablePath, checks }, null, 2),
  );
  console.log('Markdown desktop smoke passed: ' + checks.join('; '));
} catch (e) {
  await app
    .windows()[0]
    ?.screenshot({ path: 'test-results/markdown-failure.png' })
    .catch(() => {});
  throw e;
} finally {
  await app.close();
}
