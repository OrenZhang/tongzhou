import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Component integration test: no real account, network connection, or message send.
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/notification-ui-'));
await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelNotifications } from './src/features/connections/ChannelNotifications';
import { SessionNotification } from './src/features/chat/NotificationControls';
import { NotificationTargetPicker } from './src/features/connections/NotificationTargetPicker';
import { notificationTargets } from './src/shared/notification-targets';
import './src/app/styles.css';
const recipients = [
  { id: 'bot-a', name: '接收人 A', kind: 'feishu', available: true },
  { id: 'bot-b', name: '接收人 B', kind: 'feishu', available: true },
  { id: 'bot-c', name: '接收人 C', kind: 'weixin', available: false, reason: '请先完成机器人授权' },
];
window.saved = [];
function Fixture() {
  const [rules, setRules] = useState([]);
  const [selected, setSelected] = useState('');
  const data = { notificationTargets: recipients, channels: [
    { id: 'webhook', name: 'Webhook', kind: 'feishu', enabled: true },
    { id: 'disabled', name: '停用渠道', kind: 'email', enabled: false },
  ], notificationRules: rules, sessions: [{ id: 'session', title: '测试会话' }], projects: [] };
  const api = { saveNotificationRule: async (rule) => {
    window.saved.push(rule);
    setRules((items) => [...items.filter((item) => item.id !== rule.id), rule]);
  } };
  return <main style={{padding: 30}}>
    <ChannelNotifications targets={recipients} data={data} api={api} refresh={async () => {}} manage={() => {}} />
    <SessionNotification session={data.sessions[0]} data={data} api={api} onError={(e) => { throw e; }} />
    <section aria-label="定时任务目标">
      <NotificationTargetPicker targets={notificationTargets(data)} value={selected} onChange={setSelected} optional />
    </section>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);`,
  },
  jsx: 'automatic',
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: path.join(root, 'fixture.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(
  path.join(root, 'index.html'),
  '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
);
await writeFile(
  path.join(root, 'main.cjs'),
  `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:800});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(root, 'main.cjs')], env });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('渠道接收人').selectOption('bot-b');
  await page.getByRole('button', { name: '通知规则', exact: true }).click();
  assert.equal(await page.getByLabel('通知接收人').count(), 0);
  await page.getByRole('button', { name: '添加通知规则' }).click();
  assert.match(await page.getByRole('dialog').innerText(), /通知目标：接收人 B/);
  await page.getByRole('button', { name: '保存规则' }).click();
  assert.equal(await page.evaluate(() => window.saved.at(-1).channelId), 'bot-b');
  await page.getByLabel('渠道接收人').selectOption('bot-a');
  assert.equal(await page.locator('.notification-rule').count(), 0);
  await page.getByRole('button', { name: '会话通知', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const options = await dialog
    .locator('select option')
    .evaluateAll((items) => items.map((item) => ({ value: item.value, disabled: item.disabled })));
  assert.ok(options.some((item) => item.value === 'bot-b' && !item.disabled));
  assert.ok(options.some((item) => item.value === 'bot-c' && item.disabled));
  assert.ok(options.some((item) => item.value === 'disabled' && item.disabled));
  assert.deepEqual(
    options.slice(1),
    await page
      .getByRole('region', { name: '定时任务目标' })
      .locator('option')
      .evaluateAll((items) =>
        items.slice(1).map((item) => ({ value: item.value, disabled: item.disabled })),
      ),
  );
  await dialog.getByLabel('通知目标').selectOption('bot-b');
  await dialog.getByRole('button', { name: '提醒下一轮结束' }).click();
  const saved = await page.evaluate(() => window.saved.at(-1));
  assert.equal(saved.channelId, 'bot-b');
  assert.equal(saved.sessionId, 'session');
  assert.equal(saved.once, true);
  await page.getByLabel('渠道接收人').selectOption('bot-c');
  assert.equal(await page.getByRole('button', { name: '添加通知规则' }).isDisabled(), true);
  await page.screenshot({ path: path.join(root, 'notifications.png') });
  assert.deepEqual(errors, []);
  console.log(
    'Notification UI passed: shared recipient, saved target, bot reminders, unavailable states, consistent task targets.',
    root,
  );
} finally {
  await app.close();
}
