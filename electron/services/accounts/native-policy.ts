import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import TOML from '@iarna/toml';
import YAML from 'yaml';
import type { NativeEngine } from '../../../src/shared/types';

/** Managed CLI homes only. Native tools are replaced by Tongzhou's per-run MCP scope. */
export function configureNativeTools(kind: NativeEngine, home: string) {
  const target = path.join(home, kind === 'kimi' ? 'config.toml' : 'config.yaml');
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
  // MiniMax must seed its managed-login provider before tool overrides are written.
  // A partial first config makes ACP treat the account as an unconfigured API provider.
  if (kind === 'minimax' && !before) return;
  let config: any = before ? (kind === 'kimi' ? TOML.parse(before) : YAML.parse(before)) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('引擎配置格式无效');
  if (kind === 'kimi') {
    config.tools = { ...config.tools, enabled: ['mcp__tongzhou-tools__*'] };
  } else {
    config.agents = {
      ...config.agents,
      default: {
        ...config.agents?.default,
        tools: [],
        builtinTools: [],
        skills: [],
        persona: { enabled: false },
        features: { mavis: false, delegation: false, webSearch: false },
      },
    };
    config.memory = { ...config.memory, enabled: false, proactive: false };
    config.askUser = { enabled: false };
    config.skills = { ...config.skills, external: { enabled: false } };
    config.beta = { ...config.beta, desktopPlanMode: false, threadGoal: false, autoMemory: false };
  }
  const after = kind === 'kimi' ? TOML.stringify(config) : YAML.stringify(config);
  if (after === before) return;
  if (before && !existsSync(target + '.before-tongzhou-tools'))
    writeFileSync(target + '.before-tongzhou-tools', before, { mode: 0o600, flag: 'wx' });
  const temp = target + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, after, { mode: 0o600, flag: 'wx' });
  renameSync(temp, target);
}
