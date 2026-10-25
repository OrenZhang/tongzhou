import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openCanvas, openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-controls-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const seed = await page.evaluate(async () => {
    const api = window.tongzhou,
      owner = await api.createSession();
    await api.setSessionPermission(owner.id, 'full-access');
    const node = (id, pluginId, x, y, config, text) => ({
      id,
      title: id,
      kind: 'plugin',
      pluginId,
      x,
      y,
      config,
      text,
    });
    const edge = (from, to, fromPort = 'result') => ({
      id: from + ':' + fromPort + ':' + to,
      from,
      to,
      fromPort,
      toPort: 'context',
      kind: 'dependency',
    });
    const canvas = await api.canvasSave({
      title: '控制流交互回归',
      viewport: { x: 40, y: 40, zoom: 0.6 },
      selection: [],
      nodes: [
        {
          id: 'source',
          title: '数组输入',
          kind: 'text',
          x: 0,
          y: 0,
          text: '[{"score":80},{"score":20}]',
        },
        node('循环', 'workflow.foreach', 300, 0, {
          endNodeId: '汇总',
          maxItems: 10,
          onError: 'stop',
        }),
        node('条件', 'workflow.condition', 600, 0, {
          field: 'value.score',
          operator: 'gte',
          value: '60',
        }),
        node('通过', 'workflow.template', 900, 0, undefined, '通过：{{input}}'),
        node('略过', 'workflow.template', 900, 260, undefined, '略过：{{input}}'),
        node('分支汇合', 'workflow.join', 1200, 0, { mode: 'any' }),
        node('汇总', 'workflow.collect', 1500, 0),
        node('故障', 'workflow.template', 0, 520, undefined, '{{input.99}}'),
        node('兜底', 'workflow.template', 300, 520, undefined, '已兜底：{{input}}'),
        node('正常后续', 'workflow.template', 300, 780, undefined, '{{input}}'),
        node('并行一', 'workflow.delay', 600, 520, { seconds: 1 }),
        node('并行二', 'workflow.delay', 900, 520, { seconds: 1 }),
        node('并行汇合', 'workflow.join', 1200, 520, { mode: 'all' }),
      ],
      edges: [
        edge('source', '循环'),
        edge('循环', '条件', 'item'),
        edge('条件', '通过', 'true'),
        edge('条件', '略过', 'false'),
        edge('通过', '分支汇合'),
        edge('略过', '分支汇合'),
        edge('分支汇合', '汇总'),
        edge('故障', '兜底', '$error'),
        edge('故障', '正常后续'),
        edge('并行一', '并行汇合'),
        edge('并行二', '并行汇合'),
      ],
    });
    await api.canvasBind(owner.id, canvas.id);
    return { canvasId: canvas.id, ownerId: owner.id };
  });
  await openSidebar(page, '创作');
  await openCanvas(page, seed.canvasId);
  await page.getByRole('button', { name: '画布设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '画布设置', exact: true });
  await settings.getByLabel('画布会话', { exact: true }).selectOption(seed.ownerId);
  await settings.getByLabel('最大并行节点数', { exact: true }).fill('2');
  await settings.getByLabel('总执行步数上限', { exact: true }).fill('100');
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '运行整个流程', exact: true }).click();
  await page.waitForFunction(async (id) => {
    const run = (await window.tongzhou.canvasState(id)).runs[0];
    return run && run.status !== 'running';
  }, seed.canvasId);
  const state = await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId);
  const run = state.runs[0];
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.deepEqual(state.canvas.execution, { concurrency: 2, maxSteps: 100 });
  assert.equal(run.nodes['正常后续'].status, 'skipped');
  assert.equal(run.nodes['故障'].handled, true);
  assert.equal(run.nodes['汇总'].output.value.length, 2);
  assert(run.nodes['汇总'].output.value[0].startsWith('通过：'));
  assert(run.nodes['汇总'].output.value[1].startsWith('略过：'));
  assert(run.nodes['并行一'].startedAt < run.nodes['并行二'].endedAt);
  assert(run.nodes['并行二'].startedAt < run.nodes['并行一'].endedAt);
  await page.getByRole('button', { name: '适应', exact: true }).click();
  const loop = page.getByRole('article', { name: '循环，工具调用', exact: true });
  await loop.locator('header').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '配置节点', exact: true }).click();
  await page.getByLabel('配对汇总节点', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('配对汇总节点', { exact: true }).inputValue(), '汇总');
  const history = page.getByRole('region', { name: '遍历记录', exact: true });
  assert.equal(await history.locator('details').count(), 2);
  await history.locator('summary').first().click();
  await page.screenshot({ path: path.join(root, 'controls.png') });
  await page
    .getByRole('dialog', { name: '节点配置', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  const before = state.canvas.nodes.length;
  await page.locator('[data-node-plugin="workflow.foreach"]').click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const added = await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId);
  assert.equal(added.canvas.nodes.length, before + 2);
  const start = added.canvas.nodes.find(
    (n) => n.id !== '循环' && n.pluginId === 'workflow.foreach',
  );
  assert(
    added.canvas.nodes.some(
      (n) => n.id === start.config.endNodeId && n.pluginId === 'workflow.collect',
    ),
  );
  assert(
    added.canvas.edges.some(
      (e) => e.from === start.id && e.to === start.config.endNodeId && e.fromPort === 'item',
    ),
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, 'report.json'),
    JSON.stringify(
      {
        status: 'passed',
        runId: run.id,
        steps: run.stepsExecuted,
        iterations: run.nodes['循环'].iterations.length,
      },
      null,
      2,
    ),
  );
  console.log(
    'Canvas control flow smoke passed: conditions, loops, parallel join, failure routing, settings, history and paired palette nodes. ' +
      root,
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-5000));
  }
  throw error;
} finally {
  if (app) await app.close();
}
