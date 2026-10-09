import { openModels } from './navigation-helper.mjs';
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/client-management-'));
let step = 0;
let createdId;
let createdSkillId, folderId, documentId, documentVersion;
let deletionConfirmed = false;
const nativeFile = path.join(root, 'codex-native-file.txt');
const skillSource =
  '---\nname: release-notes\ndescription: Draft release notes from changes.\n---\nRead references/format.md and prepare the requested notes.';
const failures = [],
  errors = [];
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const b of req) raw += b;
    const body = JSON.parse(raw);
    const previous = body.messages.filter((m) => m.role === 'tool').at(-1);
    let value = previous?.content;
    try {
      value = JSON.parse(value);
    } catch {
      /* Skill files are plain text. */
    }
    const tools = body.tools.map((t) => t.function.name);
    assert.ok(tools.includes('client_catalog'));
    const calls = [
      () => ['client_catalog', { method: 'setAppearance' }],
      () => {
        assert.equal(value.methods[0].arguments.prefixItems[0].properties.style.type, 'string');
        return [
          'client_change',
          {
            method: 'setAppearance',
            args: [{ theme: 'dark', style: 'blue', font: 'system', textSize: 18 }],
          },
        ];
      },
      () => {
        assert.equal(value.success, true);
        return ['client_change', { method: 'createSession', args: [] }];
      },
      () => {
        assert.ok(value.id);
        createdId = value.id;
        return [
          'client_change',
          { method: 'updateSession', args: [createdId, { title: '会话工具创建的任务' }] },
        ];
      },
      () => {
        assert.equal(value.success, true);
        return ['client_query', { method: 'snapshot', args: [] }];
      },
      () => {
        assert.ok(
          Array.isArray(value.sessions),
          'Unexpected snapshot output: ' + JSON.stringify(value).slice(-400),
        );
        assert.ok(value.sessions.some((s) => s.id === createdId));
        assert.ok(value.skills.some((s) => s.id === 'tongzhou-skill-creator' && s.enabled));
        return ['read_skill_file', { skillId: 'tongzhou-skill-creator', path: 'SKILL.md' }];
      },
      () => {
        assert.ok(value.includes('createSkill'));
        return ['client_catalog', { method: 'createSkill' }];
      },
      () => {
        assert.equal(value.methods[0].access, 'change');
        assert.equal(
          value.methods[0].arguments.prefixItems[0].properties.instructions.type,
          'string',
        );
        return [
          'client_change',
          {
            method: 'createSkill',
            args: [
              {
                instructions: skillSource,
                files: { 'references/format.md': '# Changes\nGroup by user-visible behavior.' },
              },
            ],
          },
        ];
      },
      () => {
        assert.equal(value.name, 'release-notes');
        assert.equal(value.enabled, true);
        createdSkillId = value.id;
        return ['client_query', { method: 'snapshot', args: [] }];
      },
      () => {
        assert.ok(
          value.sessions.some((s) => s.id === createdId && s.title === '会话工具创建的任务'),
        );
        assert.ok(
          value.skills.some((s) => s.id === createdSkillId && s.instructions === skillSource),
        );
        return ['client_catalog', { method: 'contentWrite' }];
      },
      () => {
        assert.equal(value.methods[0].available, true);
        assert.equal(value.methods[0].access, 'change');
        return ['content_folder', { name: '会话直接保存', libraryId: 'default' }];
      },
      () => {
        folderId = value.id;
        return [
          'client_change',
          {
            method: 'contentWrite',
            args: [
              {
                libraryId: 'default',
                folderId,
                title: '会话真实正文',
                content: '# 测试正文\n\n已经持久化。',
              },
            ],
          },
        ];
      },
      () => {
        assert.equal(value.persisted, true);
        documentId = value.id;
        documentVersion = value.version;
        return ['content_read', { id: documentId }];
      },
      () => {
        assert.equal(value.content, '# 测试正文\n\n已经持久化。');
        return ['client_query', { method: 'personalizationState' }];
      },
      () => [
        'client_change',
        {
          method: 'savePersonalization',
          args: [{ ...value.profile, userPreferences: '请使用简洁中文回答。' }],
        },
      ],
      () => ['client_query', { method: 'personalizationState' }],
      () => {
        assert.equal(value.profile.userPreferences, '请使用简洁中文回答。');
        const tool = body.tools.find((t) =>
          /(?:^|_)(shell_command|exec_command|shell)$/.test(t.function.name),
        );
        assert.ok(
          tool,
          'Ordinary chats must expose native Codex file execution: ' + tools.join(','),
        );
        const properties = tool.function.parameters.properties;
        const command =
          process.platform === 'win32'
            ? "[System.IO.File]::WriteAllText('" +
              nativeFile.replaceAll("'", "''") +
              "', 'codex-native-success')"
            : "printf '%s' 'codex-native-success' > '" + nativeFile.replaceAll("'", "'\\''") + "'";
        const args = properties.cmd
          ? { cmd: command }
          : {
              command:
                properties.command?.type === 'array'
                  ? process.platform === 'win32'
                    ? ['powershell.exe', '-NoProfile', '-Command', command]
                    : ['/bin/sh', '-c', command]
                  : command,
            };
        return [tool.function.name, args];
      },
      () => ['client_change', { method: 'knowledgeDelete', args: [documentId, documentVersion] }],
    ];
    let delta, finish_reason;
    if (step < calls.length) {
      const [name, args] = calls[step]();
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'management-' + step,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      };
      finish_reason = 'tool_calls';
    } else {
      assert.match(String(value), /未批准/);
      delta = {
        content: '已验证客户端配置、技能、内容保存及 Codex 原生文件能力；删除被拒绝，原文保留。',
      };
      finish_reason = 'stop';
    }
    step++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n',
    );
  } catch (error) {
    failures.push(String(error));
    res.writeHead(500);
    res.end('合成服务断言失败');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setIgnoreMouseEvents(true);
    w.setContentSize(1150, 950);
  });
  assert.equal(
    await page.locator('.sidebar').getByRole('button', { name: '连接中心', exact: true }).count(),
    0,
  );
  await openModels(page);
  assert.equal(await page.getByRole('button', { name: '服务与浏览器', exact: true }).count(), 0);
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '打开连接中心', exact: true }).click();
  await page.getByRole('heading', { name: '连接中心', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '添加连接', exact: true }).count(), 0);
  assert.equal(await page.locator('.sidebar-bottom .active').innerText(), '设置');
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  const catalog = await page.evaluate(() => window.tongzhou.clientMethods());
  const source = (
    await Promise.all(
      [
        'electron/main.ts',
        ...(await readdir('electron', { recursive: true }))
          .filter(
            (file) =>
              file.endsWith('-services.ts') ||
              (file.replaceAll('\\', '/').startsWith('application/features/') &&
                file.endsWith('.ts')),
          )
          .map((file) => 'electron/' + file),
      ].map((file) => readFile(file, 'utf8')),
    )
  ).join('\n');
  const names = [...source.matchAll(/^\s*(?:register|define)\(\s*'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(
    catalog.methods.map((m) => m.name).sort(),
    names.sort(),
    'every business registration must appear in the live catalog',
  );
  assert.equal(new Set(names).size, names.length);
  assert.ok(catalog.modules.length >= 10);
  for (const name of [
    'saveBot',
    'saveNotificationRule',
    'enqueue',
    'setAppearance',
    'savePlugin',
    'saveSkill',
    'createSkill',
    'syncRepository',
  ])
    assert.ok(catalog.change.includes(name));
  assert.equal(catalog.methods.find((m) => m.name === 'approve').access, 'manual');
  assert.ok(!catalog.change.includes('setDefaultPermission'));
  await page.locator('.sidebar').getByRole('button', { name: '插件', exact: true }).click();
  const card = page.getByRole('region', { name: '客户端管理能力' });
  await card.getByRole('button', { name: '复制客户端管理示例' }).click();
  const copyFeedback = card.locator('.capability-feedback');
  await copyFeedback.filter({ hasText: /已复制示例|系统剪贴板暂不可用/ }).waitFor();
  const clipboardUnavailable = (await copyFeedback.innerText()).includes('剪贴板暂不可用');
  if (clipboardUnavailable) assert.equal(await copyFeedback.getAttribute('role'), 'alert');
  else assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /同舟有哪些会话/);
  await card.locator('.client-capability-catalog > summary').click();
  await card.getByLabel('搜索客户端功能').fill('机器人');
  await card.getByText('重新连接已有机器人', { exact: true }).waitFor();
  await card.getByLabel('搜索客户端功能').fill('没有这个功能');
  await card.getByText('没有匹配的功能。').waitFor();
  await card.getByLabel('搜索客户端功能').fill('批准');
  await card.getByRole('button', { name: '打开：批准或拒绝待审批操作' }).click();
  await page.waitForSelector('.app-shell');
  const runSession = await page.evaluate(
    async (baseUrl) => {
      const api = window.tongzhou;
      await api.saveProvider({
        id: 'fixture',
        name: '本地合成模型',
        protocol: 'openai-chat',
        baseUrl,
        auth: 'none',
        models: ['mock'],
        maxOutputTokens: 2000,
        contextChars: 0,
      });
      // Only the test renderer grants full access; no model-callable privilege operation.
      const session = await api.createSession();
      await api.setSessionPermission(session.id, 'full-access');
      await api.run({
        sessionId: session.id,
        providerId: 'fixture',
        model: 'mock',
        agentId: '',
        prompt:
          '切换外观、创建技能、直接保存内容库正文和偏好。用 Codex 原生工具创建测试文件；最后测试删除确认，我将拒绝删除。',
      });
      return session.id;
    },
    'http://127.0.0.1:' + server.address().port + '/v1',
  );
  await page.locator(`[data-session-id="${runSession}"]`).click();
  const deadline = Date.now() + 90000;
  while (!failures.length && Date.now() < deadline) {
    const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
    if (snapshot.approvals.length) {
      assert.ok(
        snapshot.approvals.every((a) => a.detail.includes('knowledgeDelete')),
        'Only deletion should ask in this full-access chat',
      );
      await page
        .locator('.approval-card')
        .getByRole('button', { name: '拒绝', exact: true })
        .click();
      deletionConfirmed = true;
    }
    if (snapshot.runs.some((run) => run.status === 'completed' || run.status === 'failed')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const finished = await page.evaluate(() => window.tongzhou.snapshot());
  assert.ok(finished.runs.some((run) => run.status === 'completed'));
  assert.deepEqual(failures, []);
  assert.equal(step, 19);
  assert.equal(deletionConfirmed, true);
  assert.equal(await readFile(nativeFile, 'utf8'), 'codex-native-success');
  const stored = await page.evaluate((id) => window.tongzhou.knowledgeRead(id), documentId);
  assert.equal(stored.document.content, '# 测试正文\n\n已经持久化。');
  assert.equal(stored.document.folderId, folderId);
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'dark' &&
      document.documentElement.dataset.style === 'blue',
  );
  assert.equal(await page.locator('html').getAttribute('data-font'), 'system');
  assert.equal((await page.evaluate(() => window.tongzhou.getAppearance())).textSize, 18);
  await page.reload();
  await page.waitForSelector('.app-shell');
  await page.waitForFunction(() => document.documentElement.dataset.style === 'blue');
  await page.locator('.sidebar').getByRole('button', { name: '插件', exact: true }).click();
  await card.locator('.client-capability-catalog > summary').click();
  await card.getByLabel('搜索客户端功能').fill('外观');
  await card.getByText('设置主题、界面风格、字体和字号；立即生效并保存').waitFor();
  await card.locator('.client-capability-catalog').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/client-catalog-dark.png', animations: 'disabled' });
  await page.evaluate(() => window.tongzhou.setTheme('light'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: 'test-results/client-catalog-light.png', animations: 'disabled' });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 700),
  );
  await page.screenshot({ path: 'test-results/client-catalog-narrow.png', animations: 'disabled' });
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByLabel('类型', { exact: true }).selectOption('skill');
  await page.getByRole('heading', { name: '技能创建', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'release-notes', exact: true }).count(), 0);
  await page.screenshot({ path: 'test-results/builtin-skill-creator.png' });
  await page.getByRole('button', { name: /^个人插件/ }).click();
  await page.getByLabel('类型', { exact: true }).selectOption('skill');
  await page.getByRole('heading', { name: 'release-notes', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '技能创建', exact: true }).count(), 0);
  const savedSkills = await page.evaluate(() => window.tongzhou.snapshot());
  assert.equal(savedSkills.skills.find((s) => s.id === createdSkillId).instructions, skillSource);
  await page.screenshot({ path: 'test-results/created-personal-skill.png' });
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/client-management-report.json',
    JSON.stringify(
      {
        passed: true,
        packaged: !!executablePath,
        modules: catalog.modules,
        methods: names.length,
        requests: step,
        clipboard: clipboardUnavailable
          ? 'system denied access; correct failure shown'
          : 'copy confirmed',
        checks: [
          'complete IPC catalog',
          'search and manual entry',
          'real chat tool dispatch',
          'appearance updates and reload',
          'session creation and mutation',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Client management passed: ' +
      names.length +
      ' registrations, real chat dispatch, UI changes and persistence.',
  );
} catch (error) {
  console.error({ failures, errors, step });
  await (await app.firstWindow())
    .screenshot({ path: 'test-results/client-management-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
}
