import { describe, it, expect } from 'vitest';
import { Store } from '../electron/store';
import { configureNativeTools } from '../electron/native-policy';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import TOML from '@iarna/toml';
const codec = { encrypt: (s: string) => s, decrypt: (s: string) => s };
describe('non-seeded roles and native tool boundaries', () => {
  it('backs up a v1 database, removes only exact seeds and preserves custom roles and messages', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tongzhou-upgrade-'));
    try {
      const file = path.join(root, 'state.db');
      let s = new Store(file, codec);
      s.put('agent', {
        id: 'builder',
        name: '协作助手',
        description: '分析问题、实现功能并验证结果',
        instructions:
          '你是同舟的编程助手。先理解项目和需求，再进行有依据的修改，验证结果。使用中文回复。不要声称执行了未执行的操作。',
        permission: 'ask',
        maxSteps: 16,
        providerId: '',
        model: '',
      });
      s.put('agent', {
        id: 'reviewer',
        name: '用户自定义审查',
        instructions: 'Preserve me',
        description: '',
        permission: 'read-only',
        maxSteps: 16,
        providerId: '',
        model: '',
      });
      const session = s.createSession();
      s.put('session', { ...session, agentId: 'builder' });
      s.message({
        id: 'history',
        sessionId: session.id,
        role: 'user',
        content: 'User history',
        createdAt: 1,
      });
      s.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('1', 'schema_version');
      s.close();
      s = new Store(file, codec);
      expect(s.list<any>('agent').map((a) => a.name)).toEqual(['用户自定义审查']);
      expect(s.get<any>('session', session.id).agentId).toBe('');
      expect(s.messages(session.id)[0].content).toBe('User history');
      expect(s.get<any>('legacyAgent', 'builder').name).toBe('协作助手');
      expect(readdirSync(root).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
      s.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps new and reopened databases free of seeded Agent records', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tongzhou-migration-'));
    try {
      let s = new Store(path.join(root, 'state.db'), codec);
      expect(s.list('agent')).toEqual([]);
      expect(s.createSession().agentId).toBe('');
      s.close();
      s = new Store(path.join(root, 'state.db'), codec);
      expect(s.list('agent')).toEqual([]);
      s.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('disables native tools independently of planning and preserves provider configuration', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tongzhou-policy-'));
    try {
      writeFileSync(path.join(root, 'config.toml'), 'default_model = "example"\n');
      configureNativeTools('kimi', root);
      const kimi: any = TOML.parse(readFileSync(path.join(root, 'config.toml'), 'utf8'));
      expect(kimi.default_model).toBe('example');
      expect(kimi.tools.enabled).toEqual(['mcp__tongzhou-tools__*']);
      writeFileSync(path.join(root, 'config.yaml'), 'defaultModel: example\n');
      configureNativeTools('minimax', root);
      const mini = YAML.parse(readFileSync(path.join(root, 'config.yaml'), 'utf8'));
      expect(mini.defaultModel).toBe('example');
      expect(mini.agents.default.tools).toEqual([]);
      expect(mini.agents.default.builtinTools).toEqual([]);
      expect(mini.beta.desktopPlanMode).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
