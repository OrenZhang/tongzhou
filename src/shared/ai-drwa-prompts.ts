import novel from '../../skills/manju-production/references/upstream/制作规范/原始模板/1. 小说改漫剧提示词最终模板.txt?raw';
import storyboard from '../../skills/manju-production/references/upstream/制作规范/原始模板/2. 漫剧分镜最终母版诡史录4.0.txt?raw';
import character from '../../skills/manju-production/references/upstream/制作规范/原始模板/3. 人物资产提示词.txt?raw';
import prop from '../../skills/manju-production/references/upstream/制作规范/原始模板/4. 道具资产生成提示词.txt?raw';
import scene from '../../skills/manju-production/references/upstream/制作规范/原始模板/5. 场景资产提示词.txt?raw';
import novelGuide from '../../skills/manju-production/references/upstream/制作规范/01_小说改漫剧.md?raw';
import storyboardGuide from '../../skills/manju-production/references/upstream/制作规范/02_分镜与视频提示词.md?raw';
import characterGuide from '../../skills/manju-production/references/upstream/制作规范/03_人物资产.md?raw';
import propGuide from '../../skills/manju-production/references/upstream/制作规范/04_道具资产.md?raw';
import sceneGuide from '../../skills/manju-production/references/upstream/制作规范/05_场景资产.md?raw';
import standards from '../../skills/manju-production/references/upstream/制作规范/README.md?raw';
import continuity from '../../skills/manju-production/references/upstream/制作规范/导演规划与场记审查.md?raw';
import type { CanvasPrompt } from './canvas-prompts';

/** Reuse the attributed, vendored sources. No runtime download or duplicate template copy. */
const revision = '027eb6af743dd5393cf83da6495996fd5e333ea2';
const entry = (
  id: string,
  title: string,
  path: string,
  content: string,
  category: string,
  tags: string[],
  modified = false,
): CanvasPrompt => ({
  id: 'builtin-ai-drwa-' + id,
  title,
  content,
  category: 'AI-drwa · ' + category,
  tags: ['AI-drwa', '漫剧', ...tags],
  source: {
    name: 'AI-drwa',
    author: 'ricciL194 / AI-drwa contributors',
    path: '制作规范/' + path,
    url: `https://github.com/ricciL194/AI-drwa/blob/${revision}/制作规范/${path}`
      .split('/')
      .map((part, i) => (i < 3 ? part : encodeURIComponent(part)))
      .join('/'),
    revision,
    license: 'CC BY-NC 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
    changes: modified
      ? '仅调整制作标准中的归档约定链接，正文规则保留。'
      : '原文完整保留，未改写或删节。',
  },
});
export const aiDrwaPrompts: CanvasPrompt[] = [
  entry(
    'novel',
    '小说改漫剧提示词最终模板',
    '原始模板/1. 小说改漫剧提示词最终模板.txt',
    novel,
    '原始模板',
    ['小说', '剧本', '改编'],
  ),
  entry(
    'storyboard',
    '漫剧分镜最终母版诡史录4.0',
    '原始模板/2. 漫剧分镜最终母版诡史录4.0.txt',
    storyboard,
    '原始模板',
    ['分镜', '视频'],
  ),
  entry('character', '人物资产提示词', '原始模板/3. 人物资产提示词.txt', character, '原始模板', [
    '人物',
    '图片',
  ]),
  entry('prop', '道具资产生成提示词', '原始模板/4. 道具资产生成提示词.txt', prop, '原始模板', [
    '道具',
    '图片',
  ]),
  entry('scene', '场景资产提示词', '原始模板/5. 场景资产提示词.txt', scene, '原始模板', [
    '场景',
    '图片',
  ]),
  entry('novel-guide', '小说改漫剧 · 执行规范', '01_小说改漫剧.md', novelGuide, '执行规范', [
    '小说',
    '剧本',
    '改编',
  ]),
  entry(
    'storyboard-guide',
    '分镜与视频提示词 · 执行规范',
    '02_分镜与视频提示词.md',
    storyboardGuide,
    '执行规范',
    ['分镜', '视频'],
  ),
  entry('character-guide', '人物资产 · 执行规范', '03_人物资产.md', characterGuide, '执行规范', [
    '人物',
    '图片',
  ]),
  entry('prop-guide', '道具资产 · 执行规范', '04_道具资产.md', propGuide, '执行规范', [
    '道具',
    '图片',
  ]),
  entry('scene-guide', '场景资产 · 执行规范', '05_场景资产.md', sceneGuide, '执行规范', [
    '场景',
    '图片',
  ]),
  entry(
    'standards',
    '漫剧制作标准与统一适配规则',
    'README.md',
    standards,
    '制作规则',
    ['规范', '适配', '连续性'],
    true,
  ),
  entry('continuity', '导演规划与场记审查', '导演规划与场记审查.md', continuity, '制作规则', [
    '导演',
    '场记',
    '审查',
    '连续性',
  ]),
];
