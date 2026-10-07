import { describe, it, expect } from 'vitest';
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
      expect(skillInstructions(store, agent)).toContain(saved.id);
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
