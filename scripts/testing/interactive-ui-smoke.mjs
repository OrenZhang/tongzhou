import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/interactive-ui-'));
await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {Markdown} from './src/components/markdown/RichMarkdown';import './src/components/markdown/markdown.css';const root=createRoot(document.getElementById('root'));window.renderMarkdown=(text,streaming=false)=>root.render(<Markdown text={text} streaming={streaming}/>);window.tongzhou={copyText:async()=>{}};`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  outfile: path.join(root, 'renderer.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
});
await cp('public/interactive-preview.html', path.join(root, 'interactive-preview.html'));
await writeFile(
  path.join(root, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data:;font-src 'self';object-src 'none';base-uri 'none'"><link rel="stylesheet" href="renderer.css"><style>:root{--surface:#fff;--surface-muted:#f5f6f7;--border:#dedfe3;--ink:#222;--muted:#666;--accent:#246edb;--font-code:monospace}body{margin:24px;font:14px/1.6 system-ui}#root{max-width:900px;margin:auto}</style><div id="root"></div><script type="module" src="renderer.js"></script>`,
);
await build({
  stdin: {
    contents: `const {app,BrowserWindow}=require('electron');const {pathToFileURL}=require('node:url');const {guardPreviewNavigation}=require('./electron/services/desktop/preview-navigation');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1080,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>e.preventDefault());guardPreviewNavigation(w.webContents,pathToFileURL(${JSON.stringify(path.join(root, 'interactive-preview.html'))}).href);w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`,
    resolveDir: process.cwd(),
    loader: 'js',
  },
  outfile: path.join(root, 'main.cjs'),
  bundle: true,
  platform: 'node',
  external: ['electron'],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(root, 'main.cjs')], env });
const checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('renderer:', m.text());
  });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.waitForFunction(() => !!window.renderMarkdown);
  const render = (text, streaming = false) =>
    page.evaluate(({ text, streaming }) => window.renderMarkdown(text, streaming), {
      text,
      streaming,
    });
  const fence = (language, source, closed = true) =>
    '```' + language + '\n' + source + (closed ? '\n```' : '');
  const html = `<h2>交互示意</h2><button id="count">点击 0</button><input aria-label="名字"><p id="answer"></p><script>let n=0;document.querySelector('button').onclick=e=>e.target.textContent='点击 '+(++n);document.querySelector('input').oninput=e=>document.querySelector('#answer').textContent='你好，'+e.target.value;</script>`;
  await render(fence('html', html, false), true);
  await page.getByText('交互界面生成中…').waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  await render(fence('html', html));
  const frame = () => page.frameLocator('.html-preview iframe');
  await frame().getByRole('button', { name: '点击 0' }).dispatchEvent('click');
  await frame().getByRole('button', { name: '点击 1' }).waitFor();
  await frame().getByRole('textbox', { name: '名字' }).fill('同舟');
  await frame().getByText('你好，同舟').waitFor();
  await page.getByRole('button', { name: '源码', exact: true }).dispatchEvent('click');
  await page.locator('.html-preview-source').waitFor();
  await page.getByRole('button', { name: '预览', exact: true }).dispatchEvent('click');
  await frame().getByRole('button', { name: '点击 1' }).waitFor();
  await page.getByRole('button', { name: '展开预览', exact: true }).dispatchEvent('click');
  await page.screenshot({ path: 'test-results/interactive-ui.png' });
  assert.deepEqual(
    await frame()
      .locator('body')
      .evaluate(() => {
        let blocked = false;
        try {
          void parent.document.body;
        } catch {
          blocked = true;
        }
        return { blocked, bridge: typeof window.tongzhou, node: typeof require };
      }),
    { blocked: true, bridge: 'undefined', node: 'undefined' },
  );
  await page.getByRole('button', { name: '重新运行预览' }).dispatchEvent('click');
  await frame().getByRole('button', { name: '点击 0' }).waitFor();
  checks.push(
    'HTML buttons, input, source toggle preserving state, expansion, rerun, streaming gate, no parent/IPC/Node access',
  );
  await render(
    fence(
      'html',
      `<p id="network">等待</p><button onclick="location.href='https://example.invalid/escape'">跳转</button><script>fetch('https://example.invalid/leak').then(()=>document.querySelector('p').textContent='允许联网').catch(()=>document.querySelector('p').textContent='已阻止联网')</script>`,
    ),
  );
  await frame().getByText('已阻止联网').waitFor();
  await frame().getByRole('button', { name: '跳转' }).dispatchEvent('click');
  assert.equal(
    page.frames().some((f) => f.url().startsWith('https://example.invalid')),
    false,
  );
  await page.getByRole('button', { name: '重新运行预览' }).dispatchEvent('click');
  await frame().getByText('已阻止联网').waitFor();
  checks.push('network and frame navigation blocked');
  for (const language of ['mermaid', '']) {
    await render(fence(language, 'flowchart LR\nA[输入] --> B[结果]'));
    await page.waitForFunction(() => {
      const img = document.querySelector('.diagram-image');
      return img?.complete && img.naturalWidth > 0;
    });
  }
  checks.push('explicit and inferred Mermaid rendering');
  await render(fence('html', html));
  await frame().getByRole('button', { name: '点击 0' }).waitFor();
  await page.setViewportSize({ width: 375, height: 700 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    false,
  );
  checks.push('narrow layout');
  await writeFile(
    'test-results/interactive-ui-report.json',
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log(checks.join('\n'));
} finally {
  await app.close();
}
