import { createServer } from 'node:http';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/weixin-'));
const failures = [];
let modelScenario = 'workbench';
let routerStep = 0,
  targetId,
  hiddenId;
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const toolNames = (body.tools ?? []).map((t) => t.function.name);
    if (modelScenario !== 'workbench') {
      if (modelScenario === 'chat') {
        assert.ok(
          !toolNames.some((n) =>
            /client_|exec_command|shell_command|apply_patch|content_|knowledge_/.test(n),
          ),
          'chat mode exposes no workspace tools',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const content = modelScenario === 'chat' ? '仅聊天测试完成。' : '每日通知测试结果。';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) +
          '\n\ndata: [DONE]\n\n',
      );
      return;
    }
    assert.ok(toolNames.includes('client_query'));
    const child = body.messages.some(
      (m) => m.role === 'user' && String(m.content).includes('BOT_CHILD_FIXTURE'),
    );
    let delta,
      finish_reason = 'stop';
    if (child) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      delta = { content: '文章会话处理结果：已完成测试整理。' };
    } else {
      const last = body.messages.filter((m) => m.role === 'tool').at(-1);
      let value;
      try {
        value = JSON.parse(last?.content);
      } catch {}
      let call;
      if (routerStep === 0) call = ['client_query', { method: 'snapshot' }];
      else if (routerStep === 1) {
        assert.ok(value.sessions.some((s) => s.id === targetId));
        assert.ok(value.sessions.some((s) => s.id === hiddenId));
        call = [
          'client_change',
          {
            method: 'run',
            args: [
              {
                sessionId: targetId,
                providerId: 'fixture',
                model: 'mock',
                agentId: '',
                prompt: 'BOT_CHILD_FIXTURE：整理测试内容',
              },
            ],
          },
        ];
      } else {
        assert.equal(value.status, 'running');
        delta = { content: '已安排文章会话处理，完成后会在这里回复。' };
      }
      if (call) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: 'bot-router-' + routerStep,
              type: 'function',
              function: { name: call[0], arguments: JSON.stringify(call[1]) },
            },
          ],
        };
        finish_reason = 'tool_calls';
      }
      routerStep++;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n',
    );
  } catch (error) {
    failures.push(String(error));
    res.writeHead(500);
    res.end('fixture failed');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
const live = process.argv.includes('--live');
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(25_000);
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setIgnoreMouseEvents(true);
    window.setFocusable(false);
    window.blur();
  });
  if (!live)
    await app.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.weixinSmoke = {
        phase: 'need_verifycode',
        messages: [],
        sent: [],
        typing: [],
        expired: false,
        cursor: '',
        polls: 0,
      };
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname !== 'ilinkai.weixin.qq.com') return original(input, init);
        const state = globalThis.weixinSmoke;
        const json = (value) => new Response(JSON.stringify(value));
        if (url.pathname.endsWith('/get_bot_qrcode'))
          return json({
            qrcode: 'fixture-code',
            qrcode_img_content: 'https://weixin.qq.com/fixture',
          });
        if (url.pathname.endsWith('/get_qrcode_status')) {
          if (url.searchParams.get('verify_code') === '123456' || state.phase === 'confirmed')
            return json({
              status: 'confirmed',
              bot_token: 'fixture-weixin-token',
              ilink_bot_id: 'fixture-weixin-bot',
              ilink_user_id: 'fixture-owner',
              baseurl: 'https://ilinkai.weixin.qq.com',
            });
          return json({ status: state.phase });
        }
        if (url.pathname.endsWith('/getupdates')) {
          state.polls++;
          state.cursor = JSON.parse(init.body).get_updates_buf;
          if (state.expired) return json({ ret: -14 });
          return json({ ret: 0, msgs: state.messages.splice(0), get_updates_buf: 'fixture-next' });
        }
        if (url.pathname.endsWith('/getconfig'))
          return json({ ret: 0, typing_ticket: 'fixture-ticket' });
        if (url.pathname.endsWith('/sendtyping')) {
          state.typing.push(JSON.parse(init.body).status);
          return json({ ret: 0 });
        }
        if (url.pathname.endsWith('/sendmessage')) {
          state.sent.push(JSON.parse(init.body).msg);
          return json({ ret: 0 });
        }
        throw new Error('Unexpected fixture endpoint');
      };
    });
  let session;
  if (!live) session = await page.evaluate(() => window.tongzhou.createSession());
  await page.locator('.sidebar').getByRole('button', { name: '机器人', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 940),
  );
  await page.screenshot({ path: 'test-results/bots-empty-redesign.png' });
  await page.getByRole('button', { name: '微信 ClawBot机器人', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByRole('button', { name: /手动配置/ }).count(), 0);
  await dialog.getByRole('button', { name: /扫码接入/ }).click();
  await dialog.getByAltText('微信 ClawBot机器人授权二维码').waitFor();
  await page.screenshot({ path: `test-results/weixin-qr-${live ? 'live' : 'fixture'}.png` });
  if (live) {
    const pending = await page.evaluate(
      async () =>
        (await window.tongzhou.snapshot()).channelAuth.find((a) => a.phase === 'waiting')?.id,
    );
    assert.ok(pending);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.waitForFunction(
      async (id) =>
        (await window.tongzhou.snapshot()).channelAuth.find((a) => a.id === id)?.phase ===
        'cancelled',
      pending,
    );
  } else {
    await dialog.getByLabel('微信验证码', { exact: true }).fill('000000');
    await dialog.getByRole('button', { name: '确认验证码', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: '验证码不匹配' }).waitFor();
    await dialog.getByLabel('微信验证码', { exact: true }).fill('123456');
    await dialog.getByRole('button', { name: '确认验证码', exact: true }).click();
    await dialog.getByRole('button', { name: '配置机器人', exact: true }).click();
    let bot = await page.evaluate(async () =>
      (await window.tongzhou.snapshot()).bots.find((b) => b.kind === 'weixin'),
    );
    assert.deepEqual(bot.allowedSenders, ['fixture-owner']);
    assert.equal(bot.hasSecret, true);
    assert.equal('enabled' in bot, false);
    assert.equal(await dialog.getByLabel('Bot ID', { exact: true }).getAttribute('readonly'), '');
    assert.equal(await dialog.locator('input[type=password]').count(), 0);
    const db = new DatabaseSync(path.join(root, 'profile/tongzhou.db'), { readOnly: true });
    try {
      const encrypted = db
        .prepare('SELECT value FROM secrets WHERE id=?')
        .get('bot_' + bot.id).value;
      assert.ok(!String(encrypted).includes('fixture-weixin-token'));
    } finally {
      db.close();
    }
    assert.ok(
      !JSON.stringify(await page.evaluate(() => window.tongzhou.snapshot())).includes(
        'fixture-weixin-token',
      ),
    );
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await app.evaluate(() => {
      const m = {
        message_id: '9007199254740993',
        from_user_id: 'fixture-owner',
        to_user_id: 'fixture-weixin-bot',
        message_type: 1,
        message_state: 0,
        context_token: 'fixture-context',
        item_list: [{ type: 1, text_item: { text: '/sessions' } }],
      };
      globalThis.weixinSmoke.messages.push(m, { ...m, from_user_id: 'outsider' }, m);
    });
    await page.waitForFunction(async () =>
      (await window.tongzhou.snapshot()).bots.some((b) => b.kind === 'weixin' && b.lastMessageAt),
    );
    await page.waitForTimeout(800);
    const sent = await app.evaluate(() => globalThis.weixinSmoke.sent);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to_user_id, 'fixture-owner');
    assert.equal(sent[0].context_token, 'fixture-context');
    assert.ok(sent[0].item_list[0].text_item.text.includes(session.id.slice(0, 8)));
    assert.equal(await app.evaluate(() => globalThis.weixinSmoke.cursor), 'fixture-next');
    // Exercise real IPC, scheduler and Codex core against a local model fixture.
    await page.evaluate(async (baseUrl) => {
      await window.tongzhou.saveProvider({
        id: 'fixture',
        name: '本地测试模型',
        protocol: 'openai-chat',
        baseUrl,
        auth: 'none',
        models: ['mock'],
        maxOutputTokens: 2048,
        contextChars: 0,
      });
    }, `http://127.0.0.1:${server.address().port}`);
    await page.getByLabel('机器人模型连接', { exact: true }).selectOption('fixture');
    await page.getByLabel('机器人执行模式', { exact: true }).selectOption('full-access');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('已保存，下次消息生效', { exact: true }).waitFor();
    const settings = await page.evaluate(
      async () => (await window.tongzhou.snapshot()).botSettings,
    );
    assert.deepEqual(settings, {
      providerId: 'fixture',
      model: 'mock',
      permission: 'full-access',
      mode: 'workbench',
    });
    await page.screenshot({ path: 'test-results/bots-connected-redesign.png' });
    const inject = async (id, text) =>
      app.evaluate(
        (_electron, { id, text }) => {
          globalThis.weixinSmoke.messages.push({
            message_id: id,
            from_user_id: 'fixture-owner',
            to_user_id: 'fixture-weixin-bot',
            message_type: 1,
            message_state: 0,
            context_token: 'natural-context',
            item_list: [{ type: 1, text_item: { text } }],
          });
        },
        { id, text },
      );
    await inject('natural-greeting', '你好呀');
    for (let attempt = 0; attempt < 60; attempt++) {
      if (
        await app.evaluate(() =>
          globalThis.weixinSmoke.sent.some(
            (m) =>
              m.context_token === 'natural-context' &&
              m.item_list[0].text_item.text.includes('同舟'),
          ),
        )
      )
        break;
      await page.waitForTimeout(300);
    }
    let natural = await app.evaluate(() =>
      globalThis.weixinSmoke.sent.filter((m) => m.context_token === 'natural-context'),
    );
    assert.ok(natural.some((m) => m.item_list[0].text_item.text.includes('同舟')));
    assert.ok(!natural.some((m) => m.item_list[0].text_item.text.includes('/use')));
    assert.equal(natural.length, 1, 'one user greeting produces one reply, no acknowledgement');
    const conversation = await page.evaluate(async () =>
      (await window.tongzhou.snapshot()).sessions.find((s) => s.botConversation),
    );
    assert.ok(conversation);
    await inject('natural-introduction', '你是谁');
    await page.waitForFunction(
      async (id) =>
        (await window.tongzhou.messages(id)).filter((m) => m.role === 'assistant').length >= 2,
      conversation.id,
    );
    assert.equal(
      await page.evaluate(
        async () =>
          (await window.tongzhou.snapshot()).sessions.filter((s) => s.botConversation).length,
      ),
      1,
    );
    await page.getByLabel('机器人使用模式', { exact: true }).selectOption('chat');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.waitForFunction(
      async () => (await window.tongzhou.snapshot()).botSettings.mode === 'chat',
    );
    modelScenario = 'chat';
    await inject('chat-only', 'CHAT_ONLY_FIXTURE：请解释什么是上下文');
    for (let attempt = 0; attempt < 120; attempt++) {
      if (failures.length) throw Error(failures.join('\n'));
      if (
        await app.evaluate(() =>
          globalThis.weixinSmoke.sent.some(
            (m) => m.item_list[0].text_item.text === '仅聊天测试完成。',
          ),
        )
      )
        break;
      await page.waitForTimeout(300);
    }
    assert.equal(
      await app.evaluate(
        () =>
          globalThis.weixinSmoke.sent.filter(
            (m) => m.item_list[0].text_item.text === '仅聊天测试完成。',
          ).length,
      ),
      1,
    );
    const typing = await app.evaluate(() => globalThis.weixinSmoke.typing);
    assert.ok(typing.includes(1));
    assert.equal(typing.at(-1), 2);
    assert.ok(
      !(await app.evaluate(() => globalThis.weixinSmoke.sent)).some((m) =>
        m.item_list[0].text_item.text.includes('收到，正在处理'),
      ),
    );
    const destination = await page.evaluate(async () =>
      (await window.tongzhou.notificationTargets()).find((t) => t.kind === 'weixin'),
    );
    assert.ok(destination.available);
    const direct = await page.evaluate(
      (id) => window.tongzhou.sendChannel(id, '主动提醒测试。'),
      destination.id,
    );
    assert.equal(direct.status, 'sent');
    modelScenario = 'automation';
    const scheduled = await page.evaluate(async (id) => {
      const rule = await window.tongzhou.automationSave({
        name: '定时发送测试',
        kind: 'task',
        trigger: 'schedule',
        enabled: true,
        permission: 'read-only',
        providerId: 'fixture',
        model: 'mock',
        prompt: 'AUTOMATION_NOTIFICATION_FIXTURE：生成每日提醒',
        notificationTargetId: id,
        schedule: {
          kind: 'daily',
          time: '09:00',
          timezone: 'Asia/Shanghai',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
        },
        missed: 'skip',
      });
      await window.tongzhou.automationRun(rule.id);
      return rule;
    }, destination.id);
    for (let attempt = 0; attempt < 120; attempt++) {
      if (failures.length) throw Error(failures.join('\n'));
      if (
        await app.evaluate(() =>
          globalThis.weixinSmoke.sent.some(
            (m) => m.item_list[0].text_item.text === '每日通知测试结果。',
          ),
        )
      )
        break;
      await page.waitForTimeout(300);
    }
    assert.equal(
      await app.evaluate(
        () =>
          globalThis.weixinSmoke.sent.filter(
            (m) => m.item_list[0].text_item.text === '每日通知测试结果。',
          ).length,
      ),
      1,
    );
    assert.ok(scheduled.nextRunAt > Date.now());
    await page.evaluate((r) => window.tongzhou.automationSave({ ...r, enabled: false }), scheduled);
    modelScenario = 'workbench';
    targetId = session.id;
    hiddenId = (await page.evaluate(() => window.tongzhou.createSession())).id;
    await page.evaluate(
      async ({ bot, targetId }) => {
        await window.tongzhou.setSessionPermission(targetId, 'full-access');
        await window.tongzhou.updateSession(targetId, { title: '文章会话' });
        await window.tongzhou.saveBotSettings({
          providerId: 'fixture',
          model: 'mock',
          permission: 'full-access',
          mode: 'workbench',
        });
        await window.tongzhou.saveBot(bot);
      },
      { bot, targetId },
    );
    await inject('natural-delegation', '请让文章会话整理内容');
    for (let attempt = 0; attempt < 200; attempt++) {
      if (failures.length) throw Error(failures.join('\n'));
      if (
        await app.evaluate(() =>
          globalThis.weixinSmoke.sent.some((m) =>
            m.item_list[0].text_item.text.includes('文章会话处理结果：已完成测试整理。'),
          ),
        )
      )
        break;
      await page.waitForTimeout(300);
    }
    const delegated = await app.evaluate(() =>
      globalThis.weixinSmoke.sent.filter((m) =>
        m.item_list[0].text_item.text.includes('文章会话处理结果：已完成测试整理。'),
      ),
    );
    assert.equal(delegated.length, 1, 'delegated result must return exactly once');
    assert.equal(delegated[0].context_token, 'natural-context');
    assert.equal(delegated[0].to_user_id, 'fixture-owner');
    const taskState = await page.evaluate(() => window.tongzhou.snapshot());
    assert.ok(
      taskState.runs.some(
        (r) =>
          r.sessionId === targetId &&
          r.status === 'completed' &&
          r.config.executionCore === 'codex' &&
          r.botContext?.rootRunId,
      ),
    );
    assert.ok(routerStep >= 3);
    assert.deepEqual(failures, []);
    await app.evaluate(() => {
      globalThis.weixinSmoke.expired = true;
    });
    await page.getByText('微信登录已失效，请重新扫码连接', { exact: true }).waitFor();
    await page.getByLabel('更多操作：微信 ClawBot机器人', { exact: true }).click();
    await page.getByRole('button', { name: '重新扫码', exact: true }).click();
    await dialog.getByAltText('微信 ClawBot机器人授权二维码').waitFor();
    await app.evaluate(() => {
      globalThis.weixinSmoke.phase = 'confirmed';
    });
    await dialog.getByRole('button', { name: '配置机器人', exact: true }).waitFor();
    const bots = (await page.evaluate(() => window.tongzhou.snapshot())).bots;
    assert.equal(bots.length, 1);
    assert.equal(bots[0].id, bot.id);
    assert.equal(
      (await page.evaluate(() => window.tongzhou.snapshot())).botSettings.mode,
      'workbench',
    );
    assert.equal('enabled' in bots[0], false);

    await page.screenshot({ path: 'test-results/weixin-login-success.png' });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/weixin-${live ? 'live' : 'fixture'}-report.json`,
    JSON.stringify(
      {
        passed: true,
        live,
        checked: live
          ? 'real QR and cancellation'
          : 'verification, encrypted credentials, owner binding, text replies, deduplication, cursor, session expiration and same-bot reauthorization',
      },
      null,
      2,
    ),
  );
  console.log(`Weixin ${live ? 'live QR' : 'end-to-end fixture'} passed.`);
} catch (error) {
  await app
    .windows()[0]
    ?.screenshot({ path: `test-results/weixin-${live ? 'live' : 'fixture'}-failure.png` })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
