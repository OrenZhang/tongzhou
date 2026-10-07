import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { within, files } from '../../core/tools/workspace';

export async function initializeAgent(root: string) {
  for (const name of ['AGENTS.md', 'agent.md', 'agents.md']) {
    const full = await within(root, name, true);
    try {
      await access(full);
      return { path: full, created: false };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(await readFile(await within(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    /* not a Node project */
  }
  const entries = await files(root, '.');
  const commands = ['test', 'typecheck', 'lint', 'build'].filter(
    (name) => typeof scripts[name] === 'string',
  );
  const content = `# ${path.basename(root)} 项目说明\n\n## 目录\n\n${entries
    .slice(0, 30)
    .map((e) => '- ' + e.name + (e.directory ? '/' : ''))
    .join(
      '\n',
    )}\n\n## 开发约定\n\n- 修改前阅读相关代码和已有说明；遵循项目现有风格。\n- 保留已有未提交修改；写入前重新核对文件内容。\n- 只执行与需求相关的改动，工具失败时说明实际结果。\n- 不读取或提交密钥、Cookie、真实账号和本地测试数据。\n\n## 已发现的验证命令\n\n${commands.length ? commands.map((name) => '- npm run ' + name + '（package.json: ' + scripts[name].replace(/[\r\n]/g, ' ') + '）').join('\n') : '尚未发现标准 npm 验证脚本。请根据仓库文档补充正确命令。'}\n\n## 维护\n\n此文件由同舟根据目录与配置生成。请补充项目目标、业务约束和环境准备；现有文件不会被自动覆盖。\n`;
  const full = await within(root, 'agent.md', true);
  try {
    await writeFile(full, content, { encoding: 'utf8', flag: 'wx' });
    return { path: full, created: true };
  } catch (e: any) {
    if (e.code === 'EEXIST') return { path: full, created: false };
    throw e;
  }
}
