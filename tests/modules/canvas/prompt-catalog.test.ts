import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { canvasPrompts, fillPrompt } from '../../../src/shared/canvas-prompts';

describe('bundled AI-drwa prompt catalog', () => {
  it('includes all five original templates and seven companion guides in full', () => {
    const root = path.resolve('skills/manju-production/references/upstream');
    const prompts = canvasPrompts.filter((p) => p.source?.name === 'AI-drwa');
    const originals = readdirSync(path.join(root, '制作规范/原始模板'))
      .filter((f) => f.endsWith('.txt'))
      .map((f) => '制作规范/原始模板/' + f);
    const guides = readdirSync(path.join(root, '制作规范'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => '制作规范/' + f);
    expect(prompts.map((p) => p.source!.path).sort()).toEqual([...originals, ...guides].sort());
    expect(prompts.filter((p) => p.category === 'AI-drwa · 原始模板')).toHaveLength(5);
    expect(prompts.filter((p) => p.category === 'AI-drwa · 执行规范')).toHaveLength(5);
    expect(prompts.filter((p) => p.category === 'AI-drwa · 制作规则')).toHaveLength(2);
    for (const prompt of prompts) {
      const original = readFileSync(path.join(root, prompt.source!.path), 'utf8');
      expect(prompt.content.replace(/\r\n/g, '\n')).toBe(original.replace(/\r\n/g, '\n'));
      expect(fillPrompt(prompt.content, {})).toBe(prompt.content);
      expect(prompt.content.length).toBeLessThanOrEqual(32000);
      const url = new URL(prompt.source!.url);
      expect(url.hostname).toBe('github.com');
      expect(decodeURIComponent(url.pathname)).toBe(
        `/ricciL194/AI-drwa/blob/${prompt.source!.revision}/${prompt.source!.path}`,
      );
    }
    expect(new Set(canvasPrompts.map((p) => p.id)).size).toBe(canvasPrompts.length);
    expect(canvasPrompts.some((p) => p.id === 'builtin-storyboard')).toBe(true);
  });
});
