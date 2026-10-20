import { describe, it, expect, vi } from 'vitest';
import { workspacePlugin } from '../../../electron/application/features/workspace';
import type { ClientOperation } from '../../../electron/core/tools/client-commands';
vi.mock('electron', () => ({ clipboard: {}, shell: {} }));
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import {
  ensureBuiltinSkills,
  createPersonalSkill,
  saveExistingSkill,
  parseSkill,
  createSkillSchema,
} from '../../../electron/modules/plugins/skills';
import { ClientCommands, operation } from '../../../electron/core/tools/client-commands';
import { ToolScope, skillInstructions } from '../../../electron/core/tools/extensions';
import type { SkillRecord, AgentProfile } from '../../../src/shared/types';

const instructions =
  '---\nname: release-notes\ndescription: Draft release notes from a change list.\n---\nRead references/format.md and draft the requested notes.';
const agent: AgentProfile = {
  id: 'test',
  name: 'test',
  description: '',
  instructions: '',
  providerId: '',
  model: '',
  permission: 'ask',
  maxSteps: 10,
};
const openStore = () => new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });

describe('built-in skill creator and personal skills', () => {
  it('installs the bundled skill, repairs its text on upgrade, and preserves a disabled switch and personal content', () => {
    const store = openStore();
    try {
      ensureBuiltinSkills(store, path.resolve('skills'));
      const builtin = store.get<SkillRecord>('skill', 'tongzhou-skill-creator');
      expect(builtin).toMatchObject({ name: 'skill-creator', enabled: true, files: {} });
      expect(parseSkill({ instructions: builtin.instructions }).name).toBe(builtin.name);
      const personal = createPersonalSkill(store, { instructions });
      saveExistingSkill(store, { ...builtin, enabled: false });
      store.put('skill', { ...builtin, enabled: false, instructions: 'old bundled text' });
      ensureBuiltinSkills(store, path.resolve('skills'));
      expect(store.get<SkillRecord>('skill', builtin.id)).toEqual({ ...builtin, enabled: false });
      expect(store.get('skill', personal.id)).toEqual(personal);
      expect(() => saveExistingSkill(store, { ...builtin, instructions: 'overwrite' })).toThrow(
        '不可覆盖',
      );
      expect(() => createPersonalSkill(store, { instructions: builtin.instructions })).toThrow(
        '同名',
      );
    } finally {
      store.close();
    }
  });
  it('stores complete text resources, updates them, rejects unknown IDs and malformed packages without partial writes', () => {
    const store = openStore();
    try {
      const skill = createPersonalSkill(store, {
        instructions,
        files: { 'references/format.md': '# Changes' },
      });
      expect(skill.files).toEqual({ 'references/format.md': '# Changes' });
      saveExistingSkill(store, { ...skill, files: { 'references/format.md': '# Updated' } });
      expect(store.get<SkillRecord>('skill', skill.id).files['references/format.md']).toBe(
        '# Updated',
      );
      expect(() => saveExistingSkill(store, { ...skill, id: 'missing' })).toThrow('不存在');
      expect(() => createPersonalSkill(store, { instructions })).toThrow('同名');
      for (const input of [
        { instructions: 'no frontmatter' },
        { instructions: '---\nname: invalid name\ndescription: test\n---\nContent' },
        { instructions, files: { '../escape': 'content' } },
        { instructions, files: { 'C:/escape': 'content' } },
        { instructions, files: { 'SKILL.md': 'shadow' } },
        { instructions, files: { '.env': 'secret' } },
        { instructions, files: { a: '\0' } },
      ])
        expect(() => createPersonalSkill(store, input)).toThrow();
      expect(store.list('skill')).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it('creates through approved client tools, denies rejected/read-only changes, and discovers saved resources next turn', async () => {
    const store = openStore();
    const commands = new ClientCommands();
    commands.register(
      'createSkill',
      operation('Skills', 'change', 'Create', [createSkillSchema]),
      (raw) => createPersonalSkill(store, raw),
    );
    const scopes: ToolScope[] = [];
    try {
      const denied = new ToolScope(
        new AbortController().signal,
        async () => false,
        () => {},
      );
      scopes.push(denied);
      commands.attach(denied, false, () => true, 'session');
      expect(
        (await denied.call('client_change', { method: 'createSkill', args: [{ instructions }] }))
          .isError,
      ).toBe(true);
      expect(store.list('skill')).toHaveLength(0);
      const readonly = new ToolScope(
        new AbortController().signal,
        async () => true,
        () => {},
      );
      scopes.push(readonly);
      commands.attach(readonly, true, () => true, 'session');
      expect(readonly.has('client_change')).toBe(false);
      const writer = new ToolScope(
        new AbortController().signal,
        async () => true,
        () => {},
      );
      scopes.push(writer);
      commands.attach(writer, false, () => true, 'session');
      const result = await writer.call('client_change', {
        method: 'createSkill',
        args: [{ instructions, files: { 'references/format.md': 'Expected format' } }],
      });
      expect(result.isError).toBeUndefined();
      const saved = JSON.parse(result.text!);
      expect(skillInstructions(store)).toContain(saved.id);
      const reader = new ToolScope(
        new AbortController().signal,
        async () => true,
        () => {},
      );
      scopes.push(reader);
      await reader.prepare(store, agent);
      expect(
        await reader.call('read_skill_file', { skillId: saved.id, path: 'references/format.md' }),
      ).toEqual({ text: 'Expected format' });
      saveExistingSkill(store, { ...saved, enabled: false });
      expect(
        (await reader.call('read_skill_file', { skillId: saved.id, path: 'SKILL.md' })).isError,
      ).toBe(true);
    } finally {
      await Promise.all(scopes.map((scope) => scope.close()));
      store.close();
    }
  });
});

describe('unified drama skill resources', () => {
  it('bundles all five templates and reads selected resources on demand while preserving disable/upgrade behavior', async () => {
    const store = openStore();
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    try {
      ensureBuiltinSkills(store, path.resolve('skills'));
      const skill = store.get<SkillRecord>('skill', 'tongzhou-manju-production');
      const templates = Object.keys(skill.files).filter((file) => file.endsWith('.txt'));
      expect(templates).toHaveLength(5);
      expect(skill.name).toBe('manju-production');
      expect(skill.files['scripts/check_project.py']).toBeTruthy();
      expect(skill.files.LICENSE).toContain('CC BY-NC 4.0');
      const summary = skillInstructions(store);
      expect(summary).toContain(skill.id);
      expect(summary).not.toContain(skill.instructions);
      await scope.prepare(store, { ...agent, permission: 'read-only' });
      expect(await scope.call('read_skill_file', { skillId: skill.id, path: 'SKILL.md' })).toEqual({
        text: skill.instructions,
      });
      const file = templates.find((p) => p.includes('2. '))!;
      const result = await scope.call('read_skill_file', {
        skillId: skill.id,
        path: file,
        startLine: 2,
        endLine: 4,
      });
      expect(result.isError).toBeUndefined();
      expect(
        result
          .text!.split('\n')
          .slice(1)
          .map((line) => line.replace(/^\d+: /, ''))
          .join('\n'),
      ).toBe(skill.files[file].split('\n').slice(1, 4).join('\n'));
      for (const bounds of [
        { startLine: 0 },
        { startLine: 4, endLine: 2 },
        { startLine: 1, endLine: 402 },
        { startLine: 100000 },
      ]) {
        expect(
          (await scope.call('read_skill_file', { skillId: skill.id, path: file, ...bounds }))
            .isError,
        ).toBe(true);
      }
      expect(
        (await scope.call('read_skill_file', { skillId: skill.id, path: '../LICENSE' })).isError,
      ).toBe(true);
      expect(() =>
        saveExistingSkill(store, { ...skill, files: { ...skill.files, [file]: 'changed' } }),
      ).toThrow('不可覆盖');
      saveExistingSkill(store, { ...skill, enabled: false });
      expect((await scope.call('read_skill_file', { skillId: skill.id, path: file })).isError).toBe(
        true,
      );
      store.put('skill', { ...skill, enabled: false, files: {} });
      ensureBuiltinSkills(store, path.resolve('skills'));
      expect(store.get<SkillRecord>('skill', skill.id)).toEqual({ ...skill, enabled: false });
    } finally {
      await scope.close();
      store.close();
    }
  });
  it('keeps complete resources in desktop IPC while chat discovery stays small and existing personal skills remain unchanged', async () => {
    const store = openStore();
    const commands = new ClientCommands();
    const registrations = new Map<
      string,
      { definition: ClientOperation; handler: (...args: any[]) => any }
    >();
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    try {
      ensureBuiltinSkills(store, path.resolve('skills'));
      const personal = createPersonalSkill(store, {
        instructions,
        files: { 'references/format.md': 'Personal rules' },
      });
      const snapshot = { skills: store.list<SkillRecord>('skill') };
      workspacePlugin.apply(
        {
          tzClient: {
            scoped:
              () =>
              (name: string, definition: ClientOperation, handler: (...args: any[]) => any) => {
                registrations.set(name, { definition, handler });
                commands.register(name, definition, handler);
              },
          },
          tzStore: store,
          tzTasks: { snapshot: () => snapshot },
          tzCommands: commands,
          tzEnvironment: { emit() {} },
        } as any,
        undefined,
      );
      expect(registrations.get('snapshot')!.handler()).toEqual(snapshot);
      commands.attach(scope, false, () => true, 'session');
      const response = await scope.call('client_query', { method: 'snapshot' });
      const chat = JSON.parse(response.text!);
      const drama = chat.skills.find((s: SkillRecord) => s.id === 'tongzhou-manju-production');
      expect(drama.files).toBeUndefined();
      expect(drama.resourcePaths).toContain('scripts/check_project.py');
      expect(response.text!.length).toBeLessThan(JSON.stringify(snapshot).length / 3);
      expect(chat.skills.find((s: SkillRecord) => s.id === personal.id)).toEqual(personal);
      saveExistingSkill(store, { ...drama, enabled: false });
      const saved = store.get<SkillRecord>('skill', drama.id);
      expect(saved.enabled).toBe(false);
      expect(saved.files['scripts/check_project.py']).toBeTruthy();
    } finally {
      await scope.close();
      store.close();
    }
  });
});
