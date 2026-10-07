import { _electron as electron } from 'playwright';
import { cp, mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
// The source is an explicitly selected Tongzhou profile. Credentials never leave ignored local test directories.
if (process.env.TONGZHOU_LIVE_CODING !== '1' || !process.env.TONGZHOU_NATIVE_SOURCE)
  throw new Error(
    'Set TONGZHOU_LIVE_CODING=1 and TONGZHOU_NATIVE_SOURCE to an authorized Tongzhou profile',
  );
const engine = process.env.TONGZHOU_TEST_ENGINE ?? 'kimi';
if (!['kimi', 'minimax'].includes(engine)) throw new Error('Unsupported test engine');
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/chat-latency-'));
const profile = path.join(root, 'profile'),
  targetHome = path.join(profile, 'engines', engine);
await mkdir(targetHome, { recursive: true });
const source = path.join(path.resolve(process.env.TONGZHOU_NATIVE_SOURCE), 'engines', engine);
for (const name of engine === 'kimi'
  ? ['config.toml', 'credentials', 'device_id']
  : ['config.yaml', 'auth', 'preferences']) {
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
  await page.waitForSelector('.app-shell');
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
    const acceptedMs = Date.now() - started;
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
      acceptedMs,
      requestReadyMs:
        events.find((e) => e.runId === runId && e.text === '等待模型响应')?.time - run.startedAt,
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

  report.pairs = [];
  for (let sample = 1; sample <= 10; sample++) {
    const session = await page.evaluate(() => window.tongzhou.createSession());
    const code = '柚子' + sample + '号';
    const a = await run(session.id, '请记住代号「' + code + '」，只回复“记住了”。', false);
    assert.ok(a.length);
    const b = await run(session.id, '刚才的代号是什么？只回答代号。', false);
    assert.ok(b.includes(code));
    const pair = { sample, cold: report.runs.at(-2), warm: report.runs.at(-1) };
    report.pairs.push(pair);
    console.log(
      JSON.stringify({
        sample,
        cold: pair.cold.durationMs,
        warm: pair.warm.durationMs,
        accepted: [pair.cold.acceptedMs, pair.warm.acceptedMs],
      }),
    );
    await writeFile(path.join(root, 'latency-report.json'), JSON.stringify(report, null, 2));
  }
  report.checks.push(
    '10 new native sessions',
    '10 warm continuations',
    '20 successful model turns',
    'correct isolated recall in every session',
  );
  report.passed = true;
} catch (e) {
  report.error = e.message;
  console.error('Live chat latency test failed: ' + e.message);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    'test-results/latency-' + engine + '-report.json',
    JSON.stringify(report, null, 2),
  );
  await app.close();
}
