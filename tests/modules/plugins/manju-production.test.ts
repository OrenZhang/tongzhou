import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const pythonAvailable = spawnSync(python, ['--version']).status === 0;
const script = path.resolve('skills/manju-production/scripts/check_project.py');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tongzhou-manju-'));
  roots.push(root);
  const series = '连载/测试作品';
  const episode = `${series}/改编/第01集`;
  const production = `${series}/制作/第01集`;
  const input = `${production}/视频输入/EP01_整集输入`;
  const write = (file: string, value: string | Buffer) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const board = `# 分镜\n\n## EP01_B001｜开门｜总时长2秒\n| 镜头编号 | 节内时间 | 景别与运镜 | 画面与动作 | 对白 | 音效 | 实际入镜资产 |\n| EP01_S001 | 0—2秒 | 中景固定 | 林舟开门 | 开门了。 | 门响 | @林舟 @门厅 |\n`;
  const prompt = `## EP01_B001\n【空间硬锁】同一门厅\n【入口状态】林舟站门前\n【本节唯一主要动作】开门\n【出口状态】门已打开\n【禁变清单】身份不变\n【0—2秒｜EP01_S001】\n【资产】@林舟 @门厅\n【空间与站位锁】门厅右侧 起点：林舟站门前\n【工具接触与持续状态】右手触门把\n【镜头出口】门已打开\n【开镜余量】0—0.3秒\n【发声时间窗】0.3—1.7秒 林舟：开门了。\n【收尾余量】1.7—2秒\n【本节结束状态】门已打开\n`;
  const record = {
    episode: 'EP01',
    status: '文稿完成',
    block_order: ['EP01_B001'],
    device_space_limits: {},
    changes: [],
    shots: [
      {
        play_order: 1,
        block: 'EP01_B001',
        shot: 'EP01_S001',
        time: [0, 2],
        scenes: ['门厅'],
        assets: ['林舟', '门厅'],
        start: '林舟站门前',
        end: '门已打开',
        space_lock: '门厅右侧',
        tool_state: '右手触门把',
        open_window: '0—0.3秒',
        voice_window: '0.3—1.7秒 林舟：开门了。',
        close_window: '1.7—2秒',
      },
    ],
  };
  write(`${series}/README.md`, '# 作品进度\n');
  write(`${episode}/剧本.md`, '# 剧本\n林舟：开门了。\n');
  write(`${episode}/分镜脚本.md`, board);
  write(`${episode}/生成提示词.md`, prompt);
  write(`${series}/资产/第01集/资产清单.md`, '@林舟 @门厅');
  write(`${series}/资产/公共/角色/林舟/设定.md`, '已确认角色');
  write(`${series}/资产/公共/场景/门厅/设定.md`, '已确认门厅');
  write(`${production}/导演场记.json`, JSON.stringify(record));
  write(`${input}/整集提示词.md`, prompt);
  write(`${input}/素材清单.md`, '@林舟 @门厅');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  for (const file of [
    '素材/林舟.png',
    '素材/门厅.png',
    '镜头首帧/EP01_B001_首帧.png',
    '镜头首帧/EP01_B001_尾帧.png',
  ])
    write(`${input}/${file}`, png);
  const run = (stage = 'delivery', extra: string[] = []) => {
    const result = spawnSync(
      python,
      [script, '--root', root, '--episode', episode, '--stage', stage, '--json', ...extra],
      { cwd: os.tmpdir(), encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout);
    expect(result.status).toBe(report.passed ? 0 : 1);
    return report;
  };
  return { root, series, episode, input, production, board, prompt, record, write, run };
}

describe.skipIf(!pythonAvailable)('portable drama structural audit', () => {
  it('works from another working directory without the upstream repository and leaves all inputs unchanged', () => {
    const f = fixture();
    const before = readFileSync(path.join(f.root, f.production, '导演场记.json'), 'utf8');
    expect(f.run()).toMatchObject({
      passed: true,
      stage: 'delivery',
      statistics: { blocks: 1, shots: 1, assets: 2 },
    });
    expect(readFileSync(path.join(f.root, f.production, '导演场记.json'), 'utf8')).toBe(before);
  });
  it('checks only the requested stage and never treats missing or placeholder media as delivered', () => {
    const f = fixture();
    unlinkSync(path.join(f.root, f.input, '镜头首帧/EP01_B001_尾帧.png'));
    expect(f.run('script').passed).toBe(true);
    expect(f.run('storyboard').passed).toBe(true);
    expect(f.run().errors.join('\n')).toContain('尾帧.png');
    f.write(`${f.input}/镜头首帧/EP01_B001_尾帧.png`, 'version https://git-lfs.github.com/spec/v1');
    expect(f.run().errors.join('\n')).toContain('LFS');
    f.write(`${f.input}/镜头首帧/EP01_B001_尾帧.png`, '');
    expect(f.run().errors.join('\n')).toContain('文件为空');
  });
  it('reports missing continuity records, malformed fields, overlapping voice windows and overruns as failures', () => {
    const f = fixture();
    unlinkSync(path.join(f.root, f.production, '导演场记.json'));
    expect(f.run('storyboard').errors.join('\n')).toContain('导演场记');
    f.write(`${f.production}/导演场记.json`, '{');
    expect(f.run('storyboard').passed).toBe(false);
    f.write(`${f.production}/导演场记.json`, JSON.stringify({ shots: [{}] }));
    expect(f.run('storyboard').errors.join('\n')).toContain('格式错误');
    f.record.shots[0].voice_window = '0.1—1.9秒 林舟：开门了。';
    f.write(`${f.production}/导演场记.json`, JSON.stringify(f.record));
    expect(f.run('storyboard').errors.join('\n')).toContain('挤占首尾余量');
    expect(f.run('storyboard', ['--max-block-seconds', '1']).errors.join('\n')).toContain(
      '不超过1秒',
    );
  });
  it('rejects duplicate blocks, unregistered assets and stale copies', () => {
    const f = fixture();
    f.write(`${f.episode}/分镜脚本.md`, f.board + f.board);
    let errors = f.run().errors.join('\n');
    expect(errors).toContain('生成节编号重复');
    f.write(`${f.episode}/分镜脚本.md`, f.board.replace('@林舟', '@未知角色'));
    errors = f.run().errors.join('\n');
    expect(errors).toContain('未登记');
    f.write(`${f.input}/整集提示词.md`, '# 旧稿');
    expect(f.run().errors.join('\n')).toContain('不同步');
  });
  it('rejects incomplete scripts and empty projects, and confines declared files to the project root', () => {
    const f = fixture();
    f.write(`${f.episode}/剧本.md`, '  \n');
    expect(f.run('script').errors.join('\n')).toContain('内容为空');
    f.write(
      `${f.series}/record.json`,
      JSON.stringify({
        source: '/historical/cache',
        dest: '../../outside.png',
        refs: ['C:\\private\\secret.png', null],
      }),
    );
    const result = spawnSync(python, [script, '--root', f.root, '--json'], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout);
    expect(report.passed).toBe(false);
    expect(report.errors.join('\n')).toContain('越出项目根目录');
    expect(report.errors.join('\n')).toContain('机器绝对路径');
    expect(report.errors.join('\n')).toContain('不是非空路径');
    rmSync(path.join(f.root, '连载'), { recursive: true });
    const empty = spawnSync(python, [script, '--root', f.root, '--json'], { encoding: 'utf8' });
    expect(JSON.parse(empty.stdout).passed).toBe(false);
  });
});
