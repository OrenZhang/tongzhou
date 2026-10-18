import { _electron as electron } from 'playwright';
import { cp, mkdir, mkdtemp, access, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
if (process.env.TONGZHOU_LIVE_CANVAS !== '1' || !process.env.TONGZHOU_NATIVE_SOURCE)
  throw Error('Set TONGZHOU_LIVE_CANVAS=1 and TONGZHOU_NATIVE_SOURCE to the authorized profile');
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/live-canvas-'));
const profile = path.join(root, 'profile');
const engine = path.join(profile, 'engines', 'minimax');
await mkdir(engine, { recursive: true });
for (const name of ['config.yaml', 'auth', 'preferences']) {
  const source = path.join(
    path.resolve(process.env.TONGZHOU_NATIVE_SOURCE),
    'engines',
    'minimax',
    name,
  );
  try {
    await access(source);
    await cp(source, path.join(engine, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
// MiniMax namespaces its local account record by the absolute auth directory.
// Re-key only the isolated copy; never print credentials or alter the source profile.
const accountKey = (directory) =>
  createHash('sha256')
    .update(directory + '\0mcode-public')
    .digest('base64url');
const sourceKey = accountKey(
  path.join(path.resolve(process.env.TONGZHOU_NATIVE_SOURCE), 'engines', 'minimax', 'auth'),
);
const targetKey = accountKey(path.join(engine, 'auth'));
for (const region of ['cn', 'en']) {
  const file = path.join(engine, 'auth', 'prod', region, 'mcode-public', 'auth.json');
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    const prefix = `com.minimax.mcode.oauth.prod.${region}\0`;
    if (value.records?.[prefix + sourceKey]) {
      value.records[prefix + targetKey] = value.records[prefix + sourceKey];
      delete value.records[prefix + sourceKey];
      await writeFile(file, JSON.stringify(value));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
const env = { ...process.env, TONGZHOU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const report = { model: '', passed: false, cases: [] };
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  const models = await page.evaluate(() => window.tongzhou.models('minimax-account'));
  assert(models.length, 'No authenticated MiniMax model');
  report.model = models.find((m) => m === 'm:minimax:MiniMax-M3:v:') ?? models[0];
  await page.evaluate(async (models) => {
    const api = window.tongzhou;
    const provider = (await api.snapshot()).providers.find((p) => p.id === 'minimax-account');
    await api.saveProvider({ ...provider, enabled: true, models });
  }, models);
  async function setup(mode) {
    return page.evaluate(
      async ({ mode, model }) => {
        const api = window.tongzhou;
        const session = await api.createSession();
        await api.updateSession(session.id, {
          title: '隔离画布测试',
          providerId: 'minimax-account',
          model,
        });
        await api.setSessionPermission(session.id, 'full-access');
        const canvas = await api.canvasSave({
          title: '隔离画布测试',
          mode,
          ...(mode === 'whiteboard'
            ? { whiteboard: { elements: [], files: {}, appState: {} } }
            : {}),
          nodes: [],
          edges: [],
          selection: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        });
        await api.canvasBind(session.id, canvas.id);
        return {
          sessionId: session.id,
          canvasId: canvas.id,
          agentId:
            mode === 'whiteboard' ? 'builtin-whiteboard-designer' : 'builtin-canvas-workflow',
        };
      },
      { mode, model: report.model },
    );
  }
  async function run(target, name, prompt) {
    console.log('RUN', name);
    const id = await page.evaluate(
      ({ target, model, prompt }) =>
        window.tongzhou.run({
          sessionId: target.sessionId,
          providerId: 'minimax-account',
          model,
          agentId: target.agentId,
          prompt,
        }),
      { target, model: report.model, prompt },
    );
    const until = Date.now() + 240000;
    let state;
    do {
      const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
      state = snapshot.runs.find((r) => r.id === id);
      for (const a of snapshot.approvals.filter((a) => a.sessionId === target.sessionId))
        await page.evaluate((id) => window.tongzhou.approve(id, false), a.id);
      if (state && state.status !== 'running') break;
      await page.waitForTimeout(700);
    } while (Date.now() < until);
    if (state?.status === 'running') {
      await page.evaluate((id) => window.tongzhou.cancel(id), target.sessionId);
      throw Error(name + ' timed out');
    }
    const messages = await page.evaluate((id) => window.tongzhou.messages(id), target.sessionId);
    const tools = messages
      .filter((m) => m.runId === id && m.role === 'tool')
      .map((m) => m.toolName);
    report.cases.push({ name, status: state?.status, tools });
    console.log('DONE', name, state?.status, tools.join(','));
    assert.equal(state?.status, 'completed');
    return (await page.evaluate((id) => window.tongzhou.canvasState(id), target.canvasId)).canvas;
  }
  const target = await setup('whiteboard');
  let canvas = await run(
    target,
    'simple-bound-flow',
    '在当前白板画一个三步流程：开始→处理→结束。三个图形，两条真正绑定到图形的箭头，用户拖动图形时必须跟随。完成后读回核验，直接操作。',
  );
  const bindings = (c) => c.whiteboard.elements.filter((e) => e.type === 'arrow' && !e.isDeleted);
  assert.equal(bindings(canvas).length, 2);
  assert(bindings(canvas).every((e) => e.startBinding && e.endBinding));
  // Turn one arrow into the real-world broken case; retain its ID and visual appearance.
  const broken = bindings(canvas)[0],
    from = broken.startBinding.elementId,
    to = broken.endBinding.elementId;
  await page.evaluate(
    async ({ canvas, brokenId }) => {
      const { updatedAt, ...input } = canvas;
      input.whiteboard.elements = input.whiteboard.elements.map((e) =>
        e.id === brokenId
          ? { ...e, startBinding: null, endBinding: null, version: e.version + 1 }
          : { ...e, boundElements: e.boundElements?.filter((b) => b.id !== brokenId) ?? null },
      );
      await window.tongzhou.canvasSave(input);
    },
    { canvas, brokenId: broken.id },
  );
  canvas = await run(
    target,
    'repair-existing-arrow',
    `箭头 ${broken.id} 看起来连上但拖动会脱开，请原位修复它从 ${from} 到 ${to} 的绑定，不删除重建，不改变其他图形。`,
  );
  const repaired = bindings(canvas).find((e) => e.id === broken.id);
  assert.equal(repaired.startBinding?.elementId, from);
  assert.equal(repaired.endBinding?.elementId, to);
  const complex = await setup('whiteboard');
  canvas = await run(
    complex,
    'complex-login-retry',
    '在当前白板画完整登录流程：开始、输入账号密码、校验、成功、错误次数判断、提示重试、锁定、结束，共8个节点。校验通过到成功再结束，不通过到次数判断；未超限到提示重试再回输入，超限到锁定再结束。所有业务箭头都真正绑定，标清判断分支，避免重叠。完成后读取检查。',
  );
  assert(bindings(canvas).length >= 8);
  assert(bindings(canvas).every((e) => e.startBinding && e.endBinding));
  const workflow = await setup('workflow');
  canvas = await run(
    workflow,
    'character-production-plan',
    '在当前工作流画布搭建人物制作流程，仅搭建不要执行、不要生成付费图片视频或通知：角色设定文字（原创成年短发女角色），连接图片生成节点的提示词，用于头部和全身正面/侧面/背面的六格设定；该图片连接后续视频节点的首帧。保留可手动编辑配置，使用实际工具和端口；工具缺失则明确缺项，不编造插件ID。完成后读取检查。',
  );
  const image = canvas.nodes.find((n) => n.kind === 'image'),
    video = canvas.nodes.find((n) => n.kind === 'video');
  assert(image && video);
  assert(canvas.edges.some((e) => e.to === image.id && e.toPort === 'prompt'));
  assert(
    canvas.edges.some((e) => e.from === image.id && e.to === video.id && e.toPort === 'firstFrame'),
  );
  assert(!report.cases.at(-1).tools.includes('canvas_execute'));
  report.passed = true;
} finally {
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await app.close();
  if (path.resolve(profile).startsWith(path.resolve(root) + path.sep))
    await rm(profile, { recursive: true, force: true });
  console.log('Live canvas report:', root);
}
