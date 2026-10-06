import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Store } from './store';
import type { SkillRecord } from '../src/shared/types';
import { builtinSkills, isBuiltinSkill } from '../src/shared/builtin-skills';

const skillFiles = z.record(z.string(), z.string().max(500000)).superRefine((files, ctx) => {
  if (Object.keys(files).length > 200)
    ctx.addIssue({ code: 'custom', message: 'Skill 附属文件不能超过 200 个' });
  for (const [file, text] of Object.entries(files)) {
    if (
      !file ||
      /[\\:\x00-\x1f]/.test(file) ||
      file.startsWith('/') ||
      file
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.startsWith('.env')) ||
      file.toLowerCase() === 'skill.md' ||
      text.includes('\0')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Skill 文件必须使用安全的相对路径及文本内容',
        path: [file],
      });
  }
});

export const createSkillSchema = z
  .object({
    instructions: z.string().min(1).max(32000),
    files: skillFiles.optional(),
  })
  .strict();

export const saveSkillSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  instructions: z.string().max(32000),
  enabled: z.boolean(),
  files: skillFiles.optional(),
});

function checkSize(instructions: string, files: Record<string, string>) {
  if (
    instructions.length + Object.values(files).reduce((size, text) => size + text.length, 0) >
    2_000_000
  )
    throw new Error('Skill 包过大');
}

export function parseSkill(input: unknown): Omit<SkillRecord, 'id' | 'enabled'> {
  const { instructions, files = {} } = createSkillSchema.parse(input);
  const frontmatter = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error('SKILL.md 必须包含 YAML frontmatter');
  const metadata = z
    .object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      description: z.string().trim().min(1).max(500),
    })
    .parse(parse(frontmatter[1], { maxAliasCount: 0 }));
  if (!instructions.slice(frontmatter[0].length).trim()) throw new Error('SKILL.md 正文不能为空');
  checkSize(instructions, files);
  return { ...metadata, instructions, files };
}

export function createPersonalSkill(store: Store, input: unknown): SkillRecord {
  const content = parseSkill(input);
  if (store.list<SkillRecord>('skill').some((s) => s.name === content.name))
    throw new Error('已存在同名技能，请更新已有个人技能或使用其他名称');
  const skill = { ...content, id: randomUUID(), enabled: true };
  store.put('skill', skill);
  return skill;
}

export function saveExistingSkill(store: Store, input: unknown) {
  const value = saveSkillSchema.parse(input);
  const old = store.list<SkillRecord>('skill').find((s) => s.id === value.id);
  if (!old) throw new Error('技能不存在；新建技能请使用 createSkill');
  if (isBuiltinSkill(value.id)) {
    if (
      value.name !== old.name ||
      value.description !== old.description ||
      value.instructions !== old.instructions ||
      (value.files && JSON.stringify(value.files) !== JSON.stringify(old.files))
    )
      throw new Error('内置技能内容不可覆盖，请创建个人技能');
    store.put('skill', { ...old, enabled: value.enabled });
    return;
  }
  const files = value.files ?? old.files ?? {};
  checkSize(value.instructions, files);
  store.put('skill', { ...old, ...value, files });
}

/** Refresh bundled instructions on upgrade while preserving the user's switch. */
export function ensureBuiltinSkills(store: Store, root: string) {
  for (const definition of builtinSkills) {
    const content = parseSkill({
      instructions: readFileSync(path.join(root, definition.directory, 'SKILL.md'), 'utf8'),
    });
    const old = store.list<SkillRecord>('skill').find((s) => s.id === definition.id);
    store.put('skill', { ...content, id: definition.id, enabled: old?.enabled ?? true });
  }
}
