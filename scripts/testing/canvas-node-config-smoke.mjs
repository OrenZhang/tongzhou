import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openCanvas, openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-node-config-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const controlFields = {
  condition: [
    ['输入序号', 'fill', '2'],
    ['字段路径', 'fill', 'value.score'],
    ['判断方式', 'selectOption', 'gte'],
    ['比较值', 'fill', '60'],
  ],
  foreach: [
    ['遍历输入来源', 'selectOption', 'resources'],
    ['配对汇总节点', 'selectOption', 'loop-end'],
    ['最大遍历项数', 'fill', '12'],
    ['单项失败时', 'selectOption', 'continue'],
  ],
  join: [['汇合方式', 'selectOption', 'all']],
  collect: [],
};
const expectedControlConfig = {
  condition: { input: 2, field: 'value.score', operator: 'gte', value: '60' },
  foreach: { source: 'resources', endNodeId: 'loop-end', maxItems: 12, onError: 'continue' },
  join: { mode: 'all' },
};
async function checkControlFields(config, control, edit = false) {
  assert(Object.hasOwn(controlFields, control), `Missing editor coverage for ${control}`);
  assert.equal(await config.getByLabel('处理要求', { exact: true }).count(), 0);
  for (const [label, action, value] of controlFields[control]) {
    const field = config.getByLabel(label, { exact: true });
    if (edit) await field[action](value);
    assert.equal(await field.inputValue(), value, label);
  }
  if (control === 'collect')
    assert.equal(
      await config
        .getByText('汇总配对循环的每项结果，保持原数组顺序。请将循环外节点连接到汇总输出。', {
          exact: true,
        })
        .isVisible(),
      true,
    );
}
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixtures = await page.evaluate(async () => {
    const api = window.tongzhou;
    const definitions = (await api.canvasState()).plugins;
    const fixtures = [];
    for (const definition of definitions) {
      if (definition.adapter === 'mcp') continue;
      const pairedNode =
        definition.control === 'foreach'
          ? { id: 'loop-end', pluginId: 'workflow.collect', title: '配对汇总' }
          : definition.control === 'collect'
            ? {
                id: 'loop-start',
                pluginId: 'workflow.foreach',
                title: '配对遍历',
                config: { endNodeId: 'node' },
              }
            : undefined;
      const canvas = await api.canvasSave({
        title: `手动配置 ${definition.name}`,
        nodes: [
          {
            id: 'node',
            kind: definition.kind,
            pluginId: definition.id,
            title: definition.name,
            x: 40,
            y: 40,
            width: 300,
            height: 260,
            ...definition.defaults,
          },
          ...(pairedNode ? [{ kind: 'plugin', x: 440, y: 40, ...pairedNode }] : []),
        ],
        edges: pairedNode
          ? [
              {
                id: 'loop-pair',
                from: definition.control === 'foreach' ? 'node' : 'loop-start',
                to: definition.control === 'foreach' ? 'loop-end' : 'node',
                kind: 'dependency',
                fromPort: 'item',
                toPort: 'context',
              },
            ]
          : [],
        selection: [],
        viewport: { x: 25, y: 25, zoom: 1 },
      });
      fixtures.push({ canvasId: canvas.id, definition });
    }
    return fixtures;
  });
  assert(fixtures.length >= 15);
  for (const control of Object.keys(controlFields))
    assert(
      fixtures.some(({ definition }) => definition.control === control),
      `Missing ${control} plugin`,
    );
  await openSidebar(page, '创作');
  for (const { canvasId, definition } of fixtures) {
    console.log(`Check manual editor: ${definition.id} (${canvasId})`);
    await openCanvas(page, canvasId);
    await page.waitForFunction(
      (name) => document.querySelector('.canvas-node-label')?.textContent === name,
      definition.name,
    );
    const node = page.locator('.canvas-node').first();
    await node.locator('header').click();
    const config = page.getByRole('region', { name: '节点配置', exact: true });
    await config.waitFor();
    assert.equal(
      await page.getByRole('region', { name: '画布助手', exact: true }).isVisible(),
      false,
    );
    if (['image', 'video'].includes(definition.kind)) {
      await config.getByLabel('生成提示词', { exact: true }).fill('手动生成提示词');
      await config.getByRole('button', { name: '收起生成配置' }).click();
    } else {
      await config.getByLabel('节点名称', { exact: true }).fill(`手动 ${definition.name}`);
      const label =
        definition.view?.textLabel ??
        (definition.kind === 'text'
          ? '正文'
          : definition.kind === 'audio'
            ? '生成提示词'
            : definition.kind === 'resource'
              ? '自定义提示词'
              : '处理要求');
      if (definition.control) {
        await checkControlFields(config, definition.control, true);
      } else if (definition.id === 'comfyui.workflow') {
        await config
          .getByLabel('API 工作流 JSON', { exact: true })
          .fill('{"1":{"class_type":"Synthetic","inputs":{}}}');
      } else if (definition.kind !== 'save') {
        await config.getByLabel(label, { exact: true }).fill('手动编辑内容');
      }
      if (definition.id === 'visual.sticky-note') {
        await config.getByLabel('便签颜色').selectOption('pink');
        await page.screenshot({ path: path.join(root, 'sticky-settings.png') });
      }
      await config.getByRole('button', { name: '收起节点配置', exact: true }).click();
    }
    await config.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const saved = await page.evaluate((id) => window.tongzhou.canvasState(id), canvasId);
    const savedNode = saved.canvas.nodes[0];
    if (!['image', 'video'].includes(definition.kind)) {
      assert.equal(savedNode.title, `手动 ${definition.name}`);
      if (definition.control) {
        assert.deepEqual(savedNode.config, expectedControlConfig[definition.control]);
        assert.equal(savedNode.text, definition.defaults?.text);
        if (definition.control === 'foreach')
          assert.equal(
            saved.canvas.nodes.find((n) => n.id === savedNode.config.endNodeId)?.pluginId,
            'workflow.collect',
          );
        if (definition.control === 'collect')
          assert.equal(
            saved.canvas.nodes.find((n) => n.id === 'loop-start')?.config.endNodeId,
            savedNode.id,
          );
        if (['foreach', 'collect'].includes(definition.control))
          assert.deepEqual(saved.canvas.edges, [
            {
              id: 'loop-pair',
              from: definition.control === 'foreach' ? 'node' : 'loop-start',
              to: definition.control === 'foreach' ? 'loop-end' : 'node',
              kind: 'dependency',
              fromPort: 'item',
              toPort: 'context',
            },
          ]);
      } else if (definition.id === 'comfyui.workflow')
        assert.deepEqual(JSON.parse(savedNode.config.workflow), {
          1: { class_type: 'Synthetic', inputs: {} },
        });
      else if (definition.kind !== 'save') assert.equal(savedNode.text, '手动编辑内容');
    }
    await node.locator('header').click();
    await config.waitFor();
    if (definition.control) await checkControlFields(config, definition.control);
    await page.locator('.canvas-board').click({ position: { x: 10, y: 10 } });
    await config.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, []);
  console.log(
    `Manual node configuration passed for ${fixtures.length} built-in node types. ${root}`,
  );
} catch (error) {
  const page = await app.firstWindow();
  await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app.close();
}
