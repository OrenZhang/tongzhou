import { aiDrwaPrompts } from './ai-drwa-prompts';

export interface CanvasPrompt {
  id: string;
  title: string;
  tags: string[];
  content: string;
  category?: string;
  source?: {
    name: string;
    author: string;
    path: string;
    url: string;
    revision: string;
    license: string;
    licenseUrl: string;
    changes: string;
  };
}

export const canvasPrompts: CanvasPrompt[] = [
  {
    id: 'builtin-storyboard',
    title: '分镜拆解',
    tags: ['分镜', '漫剧'],
    content:
      '把以下故事拆解为 {{镜头数量}} 个镜头。每个镜头给出景别、画面、人物动作、台词和时长建议。保持人物外观与场景连续。\n故事：{{故事}}',
  },
  {
    id: 'builtin-character',
    title: '人物设定',
    tags: ['人物', '图片'],
    content:
      '为 {{人物}} 编写可用于图片生成的人物设定，包含外貌、服饰、气质和可复用的视觉特征。风格：{{风格}}。避免相互矛盾的描述。',
  },
  {
    id: 'builtin-voice',
    title: '旁白配音稿',
    tags: ['音频', '配音'],
    content:
      '将以下内容改写为适合朗读的旁白，语气为 {{语气}}，时长约 {{秒数}} 秒。只输出配音正文，避免舞台说明和格式符号。\n{{内容}}',
  },
  {
    id: 'builtin-style',
    title: '统一视觉风格',
    tags: ['图片', '风格'],
    content:
      '保留输入内容的人物、构图和情节，统一为 {{风格}}。明确色彩、光线、材质与镜头语言，并列出需要保持一致的细节。',
  },
  ...aiDrwaPrompts,
];
export function promptVariables(template: string) {
  return [
    ...new Set([...template.matchAll(/\{\{\s*([^{}\n]{1,80}?)\s*\}\}/g)].map((m) => m[1].trim())),
  ];
}
export function fillPrompt(template: string, values: Record<string, string>) {
  const missing = promptVariables(template).filter((v) => !values[v]?.trim());
  if (missing.length) throw new Error('请填写变量：' + missing.join('、'));
  const result = template.replace(
    /\{\{\s*([^{}\n]{1,80}?)\s*\}\}/g,
    (_, name) => values[name.trim()],
  );
  if (result.length > 32000) throw new Error('提示词超过节点 32000 字符上限');
  return result;
}
