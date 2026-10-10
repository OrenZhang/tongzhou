import { describe, it, expect } from 'vitest';
import { Store } from '../../electron/services/storage/store';
import { configureNativeTools } from '../../electron/services/accounts/native-policy';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import TOML from '@iarna/toml';
const codec = { encrypt: (s: string) => s, decrypt: (s: string) => s };
describe('non-seeded roles and native tool boundaries', () => {
  it('uses the current schema directly and rejects unsupported formats without migrating records', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tongzhou-schema-'));
    try {
      const file = path.join(root, 'state.db');
      const store = new Store(file, codec);
      expect(
        store.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get(),
      ).toEqual({ value: '2' });
      store.db.prepare("UPDATE metadata SET value='1' WHERE key='schema_version'").run();
      store.close();
      expect(() => new Store(file, codec)).toThrow('格式不受支持');
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
