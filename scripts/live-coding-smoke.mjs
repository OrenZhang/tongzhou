import { _electron as electron } from 'playwright';
import { cp, mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
// The source is an explicitly selected Tongzhou profile. Credentials never leave ignored local test directories.
if (process.env.TONGZHOU_LIVE_CODING !== '1' || !process.env.TONGZHOU_NATIVE_SOURCE)
  throw new Error(
    'Set TONGZHOU_LIVE_CODING=1 and TONGZHOU_NATIVE_SOURCE to an authorized Tongzhou profile',
  );
const engine = process.env.TONGZHOU_TEST_ENGINE ?? 'kimi';
if (!['kimi', 'minimax'].includes(engine)) throw new Error('Unsupported test engine');
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/live-coding-'));
const profile = path.join(root, 'profile'),
  targetHome = path.join(profile, 'engines', engine);
await mkdir(targetHome, { recursive: true });
const source = path.join(path.resolve(process.env.TONGZHOU_NATIVE_SOURCE), 'engines', engine);
for (const name of engine === 'kimi'
  ? ['config.toml', 'credentials', 'device_id']
  : ['config.yaml', 'auth']) {
  try {
    await access(path.join(source, name));
    await cp(path.join(source, name), path.join(targetHome, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
const env = { ...process.env, TONGZHOU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env, timeout: 45000 });
let page;
const report = { engine, startedAt: new Date().toISOString(), passed: false, checks: [], runs: [] };
try {
  page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow, shell }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true));
    shell.openExternal = async () => {
      throw new Error('Live test must use existing authorization');
    };
  });
  const providerId = engine + '-account';
  const models = await page.evaluate((id) => window.tongzhou.models(id), providerId);
  assert.ok(models.length, 'No authenticated models');
  const model = process.env.TONGZHOU_TEST_MODEL ?? models[0];
  report.model = model;
  async function run(sessionId, prompt, project) {
    const started = Date.now();
    const runId = await page.evaluate(
      ({ sessionId, prompt, providerId, model }) =>
        window.tongzhou.run({ sessionId, prompt, providerId, model, agentId: '' }),
      { sessionId, prompt, providerId, model },
    );
    let run;
    let timedOut = false;
    for (;;) {
      const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
      run = snapshot.runs.find((r) => r.id === runId);
      for (const approval of snapshot.approvals.filter((a) => a.sessionId === sessionId)) {
        // Approve only the requested fixture edits and bounded test commands, never client/account changes.
        const allowed =
          project &&
          (approval.title.startsWith('写入 ') || approval.title === '执行终端命令') &&
          !/remove-item|rm -|del |curl |invoke-webrequest|git push/i.test(approval.detail);
        await page.evaluate(({ id, allowed }) => window.tongzhou.approve(id, Boolean(allowed)), {
          id: approval.id,
          allowed,
        });
      }
      if (run && run.status !== 'running') break;
      if (Date.now() - started > 180000) {
        await page.evaluate((id) => window.tongzhou.cancel(id), sessionId);
        timedOut = true;
        run = (await page.evaluate(() => window.tongzhou.snapshot())).runs.find(
          (r) => r.id === runId,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const messages = await page.evaluate((id) => window.tongzhou.messages(id), sessionId);
    const events = await page.evaluate((id) => window.tongzhou.runEvents(id), sessionId);
    const commands = messages
      .filter((m) => m.runId === runId && m.role === 'tool' && m.toolName === 'run_command')
      .map((m) => {
        const split = m.content.indexOf('\n');
        try {
          const args = JSON.parse(m.content.slice(0, split));
          const result = JSON.parse(m.content.slice(split + 1));
          return {
            command: args.command,
            exitCode: result.exitCode,
            status: result.status,
            durationMs: result.durationMs,
            typeFailure: /TS2322/.test(result.output),
            testFailure: /# fail [1-9]|not ok|AssertionError/.test(result.output),
            testSuccess: /# fail 0/.test(result.output),
          };
        } catch {
          return { status: 'unavailable' };
        }
      });
    report.runs.push({
      runId,
      sessionId,
      project: project ? path.basename(project) : null,
      timedOut,
      commands,
      status: run.status,
      durationMs: Date.now() - started,
      inputTokens: run.usageReported ? run.inputTokens : null,
      outputTokens: run.usageReported ? run.outputTokens : null,
      toolNames: messages
        .filter((m) => m.runId === runId && m.role === 'tool')
        .map((m) => m.toolName),
      eventTypes: [...new Set(events.filter((e) => e.runId === runId).map((e) => e.type))],
      error: run.error,
    });
    if (timedOut) throw new Error('Live model exceeded 3 minute per-task budget');
    assert.equal(run.status, 'completed', run.error);
    return messages
      .filter((m) => m.runId === runId && m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
  }
  const chat = await page.evaluate(() => window.tongzhou.createSession());
  const hello = await run(
    chat.id,
    '你好，用一句中文向我问好。记住本轮的测试代号为「青柚七号」。',
    false,
  );
  assert.ok(hello.length);
  assert.ok(!/进入.*规划模式|启动.*规划/.test(hello));
  const recall = await run(chat.id, '刚才的测试代号是什么？只回答代号。', false);
  assert.ok(recall.includes('青柚七号'));
  report.checks.push('natural projectless greeting', 'warm multi-turn recall');
  const project = path.join(root, 'fixture-project');
  await mkdir(project);
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
  );
  await writeFile(
    path.join(project, 'math.js'),
    'export function clamp(value, min, max) { return Math.max(min, Math.max(value, max)); }\n',
  );
  await writeFile(
    path.join(project, 'math.test.js'),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { clamp } from './math.js'; test('in-range',()=>assert.equal(clamp(5,0,10),5));\n",
  );
  await writeFile(
    path.join(project, 'user-notes.txt'),
    'User-owned change: preserve this exactly.\n',
  );
  await writeFile(
    path.join(project, 'agent.md'),
    'Use existing code style. Preserve user-notes.txt. Do not modify existing test expectations. Run node --test after changing code.\n',
  );
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, project);
  const p = await page.evaluate(() => window.tongzhou.addProject());
  const session = await page.evaluate((id) => window.tongzhou.createSession(id), p.id);
  await run(
    session.id,
    '修复 math.js 中 clamp 的边界问题：小于 min 返回 min，大于 max 返回 max，中间原样返回。阅读项目说明，保留用户其他内容，运行现有测试验证。',
    project,
  );
  // Held-out assertions are outside the model's project. Do not accept model-reported success as proof.
  const check = `import {clamp} from ${JSON.stringify(pathToFileURL(path.join(project, 'math.js')).href)}; import assert from 'node:assert/strict'; for(const [n,min,max,expected] of [[5,0,10,5],[-2,0,10,0],[20,0,10,10],[0,0,0,0],[-5,-10,-1,-5]]) assert.equal(clamp(n,min,max),expected);`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', check], {
    windowsHide: true,
  });
  assert.equal(
    await readFile(path.join(project, 'user-notes.txt'), 'utf8'),
    'User-owned change: preserve this exactly.\n',
  );
  assert.ok(
    (await readFile(path.join(project, 'math.test.js'), 'utf8')).includes(
      'assert.equal(clamp(5,0,10),5)',
    ),
  );
  report.checks.push(
    'real model code repair',
    'external boundary assertions',
    'preserved user changes',
    'project instruction loading',
  );
  if (process.env.TONGZHOU_CODING_MATRIX === '1') {
    report.cases = [];
    const node = process.execPath;
    const tsc = path.resolve('node_modules/typescript/bin/tsc');
    const matrix = [
      {
        id: 'D01',
        files: {
          'entry.js':
            "import { total } from './service.js'; export const receipt = rows => total(rows);",
          'service.js':
            "import { cents } from './money.js'; export const total = rows => rows.reduce((sum, row) => sum + cents(row.price), 0);",
          'money.js': 'export const cents = n => Math.round(n * 100);',
        },
        prompt:
          '只读分析：使用项目搜索定位 receipt 如何调用 total 和 cents，给出每个函数所在的文件名，不修改文件。',
        check: async (dir, answer) => {
          for (const name of ['entry.js', 'service.js', 'money.js'])
            assert.ok(answer.includes(name));
        },
      },
      {
        id: 'D02-D06-D07',
        files: {
          'math.js':
            'export function clamp(n, min, max) { return Math.max(min, Math.max(n, max)); }',
          'math.test.js':
            "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {clamp} from './math.js'; test('range',()=>assert.equal(clamp(3,0,10),3));",
        },
        prompt: '修复 clamp 的上下边界错误，保留用户已有更改和测试，不改变说明文件。运行现有测试。',
        check: async (dir) => {
          await external(
            dir,
            "import {clamp} from './math.js'; for(const [n,l,h,v] of [[3,0,10,3],[-1,0,10,0],[50,0,10,10],[-4,-8,-1,-4]]) assert.equal(clamp(n,l,h),v);",
          );
        },
      },
      {
        id: 'D03',
        files: {
          'service.js': 'export const visibleTasks = tasks => tasks;',
          'view.js':
            "import {visibleTasks} from './service.js'; export const renderTasks = tasks => visibleTasks(tasks).map(t => '<li>'+t.title+'</li>').join('');",
          'feature.test.js':
            "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {renderTasks} from './view.js'; test('existing rendering',()=>assert.equal(renderTasks([{title:'A',done:false}]),'<li>A</li>'));",
        },
        prompt:
          '新增“只看未完成”能力：visibleTasks(tasks, onlyOpen=false) 按 done 字段过滤；renderTasks(tasks, onlyOpen=false) 向服务函数传递参数。保留现有默认行为和测试，运行测试。',
        check: async (dir) => {
          await external(
            dir,
            "import {visibleTasks} from './service.js'; import {renderTasks} from './view.js'; const tasks=[{title:'A',done:false},{title:'B',done:true}]; assert.equal(visibleTasks(tasks).length,2); assert.deepEqual(visibleTasks(tasks,true),[tasks[0]]); assert.equal(renderTasks(tasks,true),'<li>A</li>'); assert.equal(renderTasks(tasks),'<li>A</li><li>B</li>');",
          );
        },
      },
      {
        id: 'D04',
        files: {
          'math.ts': 'export function sum(a:number,b:number):number { return String(a+b); }',
          'tsconfig.json': JSON.stringify({
            compilerOptions: {
              strict: true,
              skipLibCheck: true,
              types: [],
              outDir: 'out',
              module: 'NodeNext',
              target: 'ES2022',
            },
            include: ['*.ts'],
          }),
        },
        prompt:
          '先执行 npm run build 查看类型错误，修复 math.ts 的 sum 实现（两个数字相加返回数字），保持类型约束，再重新构建确认通过。',
        check: async (dir) => {
          await promisify(execFile)(node, [tsc, '-p', dir], { windowsHide: true });
          assert.match(await readFile(path.join(dir, 'math.ts'), 'utf8'), /:\s*number/);
          assert.equal(
            JSON.parse(await readFile(path.join(dir, 'tsconfig.json'), 'utf8')).compilerOptions
              .strict,
            true,
          );
          await external(
            dir,
            "import {sum} from './math.ts'; assert.equal(sum(2,3),5); assert.equal(sum(-3,1),-2); assert.equal(sum(0,0),0);",
          );
        },
      },
      {
        id: 'D05',
        files: {
          'slug.js':
            "export const slug = input => input.trim().toLowerCase().replaceAll(' ', '-');",
          'slug.test.js':
            "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {slug} from './slug.js'; test('whitespace',()=>assert.equal(slug('  A   B\\tC  '),'a-b-c'));",
        },
        prompt:
          '先运行 node --test 确认失败，再修复 slug：去除首尾空白、小写、连续空白（含制表符）压成一个连字符。保留原测试，再运行验证。',
        check: async (dir) => {
          await external(
            dir,
            "import {slug} from './slug.js'; assert.equal(slug(' X  Y\\tZ '),'x-y-z'); assert.equal(slug('  '),''); assert.equal(slug('ABC'),'abc');",
          );
        },
      },
    ];
    const selected = process.env.TONGZHOU_CODING_CASES?.split(',');
    if (selected && selected.some((id) => !matrix.some((task) => task.id === id)))
      throw new Error('Unknown coding matrix case');
    report.caseSelection = selected ?? matrix.map((task) => task.id);
    async function external(dir, code) {
      const imports = code.replace(
        /from '\.\/(.*?)'/g,
        (_, f) => 'from ' + JSON.stringify(pathToFileURL(path.join(dir, f)).href),
      );
      await promisify(execFile)(
        node,
        ['--input-type=module', '-e', "import assert from 'node:assert/strict'; " + imports],
        { windowsHide: true },
      );
    }
    for (let attempt = 1; attempt <= 3; attempt++)
      for (const task of matrix.filter((task) => !selected || selected.includes(task.id))) {
        const dir = path.join(root, task.id + '-' + attempt);
        await mkdir(dir);
        const original = {
          ...task.files,
          'package.json': JSON.stringify({
            type: 'module',
            scripts: { test: 'node --test', build: 'node build.cjs' },
          }),
          // Avoid nesting quoted absolute executable paths through npm and cmd on Windows.
          'build.cjs': `const {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath,[${JSON.stringify(tsc)},'-p','.'],{stdio:'inherit',windowsHide:true}); if(r.error) throw r.error; process.exit(r.status ?? 1);`,
          'agent.md':
            'Preserve user-notes.txt and existing test expectations. Use the project tools. Run relevant verification. Do not change this file.',
          'user-notes.txt': 'Existing user change must stay exactly.\n',
        };
        for (const [name, content] of Object.entries(original))
          await writeFile(path.join(dir, name), content);
        if (task.id === 'D02-D06-D07') {
          const git = (...args) =>
            promisify(execFile)('git', args, { cwd: dir, windowsHide: true });
          await writeFile(path.join(dir, 'user-notes.txt'), 'Baseline note.\n');
          await git('init', '--quiet');
          await git('add', '.');
          await git(
            '-c',
            'user.name=Tongzhou test',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'commit.gpgSign=false',
            '-c',
            'core.hooksPath=.git/no-hooks',
            'commit',
            '--quiet',
            '-m',
            'Synthetic fixture baseline',
          );
          await writeFile(path.join(dir, 'user-notes.txt'), original['user-notes.txt']);
          await writeFile(
            path.join(dir, 'math.js'),
            task.files['math.js'] + '\n// Preserve existing user code comment.\n',
          );
        }
        const record = { id: task.id, attempt, passed: false };
        try {
          await app.evaluate(({ dialog }, dir) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
          }, dir);
          const project = await page.evaluate(() => window.tongzhou.addProject());
          const session = await page.evaluate(
            (id) => window.tongzhou.createSession(id),
            project.id,
          );
          const answer = await run(session.id, task.prompt, dir);
          await task.check(dir, answer);
          if (task.id === 'D02-D06-D07') {
            assert.ok(
              (await readFile(path.join(dir, 'math.js'), 'utf8')).includes(
                '// Preserve existing user code comment.',
              ),
            );
            const before = (await page.evaluate(() => window.tongzhou.snapshot())).runs.find(
              (r) => r.id === report.runs.at(-1).runId,
            )?.workspace?.before;
            assert.ok(
              before?.includes('math.js') && before?.includes('user-notes.txt'),
              'Existing Git changes must be captured before model execution',
            );
            record.existingGitChangesPreserved = true;
          }
          // Judge the workflow by actual tool results, not the model's final narrative.
          const commands = report.runs.at(-1).commands;
          if (task.id === 'D04' || task.id === 'D05') {
            const failure = commands.findIndex(
              (c) =>
                c.status === 'completed' &&
                c.exitCode !== 0 &&
                (task.id === 'D04' ? c.typeFailure : c.testFailure),
            );
            assert.ok(failure >= 0, 'Missing actual failed build/test evidence');
            assert.ok(
              commands
                .slice(failure + 1)
                .some(
                  (c) =>
                    c.status === 'completed' &&
                    c.exitCode === 0 &&
                    (task.id === 'D04'
                      ? /tsc|npm run build|node build.cjs/.test(c.command)
                      : c.testSuccess),
                ),
              'Missing successful verification after the failure',
            );
          }
          for (const [name, content] of Object.entries(original)) {
            if (task.id !== 'D01' && /test\.js$/.test(name))
              assert.ok(
                (await readFile(path.join(dir, name), 'utf8')).includes(content),
                'Original test expectations must remain intact: ' + name,
              );
            else if (task.id === 'D01' || /agent.md|user-notes.txt/.test(name))
              assert.equal(await readFile(path.join(dir, name), 'utf8'), content);
          }
          record.passed = true;
        } catch (e) {
          record.error = e.message;
        }
        report.cases.push(record);
        console.log(JSON.stringify(record));
        await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
      }
    assert.ok(
      report.cases.every((c) => c.passed),
      'One or more coding matrix tasks failed',
    );
  }
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  report.error = e.message;
  console.error('Live coding test failed: ' + e.message);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile('test-results/live-' + engine + '-report.json', JSON.stringify(report, null, 2));
  await app.close();
}
