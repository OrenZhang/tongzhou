import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as TOML from '@iarna/toml';
import type { ImportPreview, ProviderInput } from '../src/shared/types';
import { providerSchema } from './validation';

// Read-only compatibility adapter. No CC Switch code or scripts are executed.
export function parseCCSwitch(data: any): ImportPreview {
  const result: ImportPreview = { providers: [], warnings: [] };
  const rows: any[] = [];
  if (Array.isArray(data)) rows.push(...data);
  else if (Array.isArray(data.providers)) rows.push(...data.providers);
  else {
    for (const app of ['claude', 'codex', 'gemini', 'openai']) {
      const block = data[app]?.providers ?? data.providers?.[app];
      if (block) rows.push(...Object.values(block).map((p: any) => ({ ...p, app_type: app })));
    }
    if (!rows.length && data.providers && typeof data.providers === 'object')
      rows.push(...Object.values(data.providers));
  }
  for (const row of rows) {
    try {
      let cfg = row.settings_config ?? row.settingsConfig ?? {};
      if (typeof cfg === 'string') cfg = JSON.parse(cfg);
      const env = cfg.env ?? {};
      const kind = row.app_type ?? row.appType ?? 'openai';
      let baseUrl =
        cfg.baseUrl ??
        cfg.base_url ??
        env.ANTHROPIC_BASE_URL ??
        env.OPENAI_BASE_URL ??
        env.GOOGLE_GEMINI_BASE_URL ??
        '';
      let secret =
        cfg.apiKey ??
        cfg.api_key ??
        cfg.auth?.OPENAI_API_KEY ??
        env.ANTHROPIC_AUTH_TOKEN ??
        env.ANTHROPIC_API_KEY ??
        env.OPENAI_API_KEY ??
        env.GEMINI_API_KEY ??
        '';
      let model = cfg.model ?? env.ANTHROPIC_MODEL ?? env.OPENAI_MODEL ?? env.GEMINI_MODEL ?? '';
      let protocol: ProviderInput['protocol'] =
        kind === 'claude'
          ? 'anthropic'
          : kind === 'gemini'
            ? 'gemini'
            : kind === 'codex'
              ? 'openai-responses'
              : 'openai-chat';
      if (typeof cfg.config === 'string') {
        const toml: any = TOML.parse(cfg.config);
        const provider = toml.model_providers?.[toml.model_provider];
        baseUrl = provider?.base_url ?? baseUrl;
        model = toml.model ?? model;
        if (provider?.wire_api === 'chat') protocol = 'openai-chat';
      }
      if (!baseUrl)
        baseUrl =
          protocol === 'anthropic'
            ? 'https://api.anthropic.com/v1'
            : protocol === 'gemini'
              ? 'https://generativelanguage.googleapis.com/v1beta'
              : 'https://api.openai.com/v1';
      if (protocol === 'anthropic' && !/\/v1\/?$/.test(baseUrl))
        baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
      if (secret === 'PROXY_MANAGED') {
        secret = '';
        result.warnings.push(`${row.name ?? '连接'} 使用代理占位密钥，请重新填写真实密钥。`);
      }
      const input: ProviderInput = {
        id: randomUUID(),
        name: row.name ?? '导入的连接',
        protocol,
        baseUrl,
        auth: 'api-key',
        models: model ? [model] : [],
        maxOutputTokens: 8192,
        contextChars: 100000,
        secret,
      };
      result.providers.push(providerSchema.parse(input));
    } catch {
      result.warnings.push(
        `${String(row.name ?? '未知连接').slice(0, 100)} 的配置格式或服务地址不受支持，已跳过。`,
      );
    }
  }
  if (!rows.length)
    result.warnings.push(
      '未找到支持的供应商配置。请选择 CC Switch 数据库或包含 providers 的 JSON。',
    );
  result.warnings.push(
    '仅导入供应商、地址、模型与 API 密钥。OAuth 登录态、用量脚本、代理接管及 MCP/Skills 不会导入。',
  );
  return result;
}
export async function importCCSwitch(file: string): Promise<ImportPreview> {
  if (/\.(db|sqlite|sqlite3)$/i.test(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return parseCCSwitch(
        db.prepare('SELECT name, app_type, settings_config FROM providers LIMIT 500').all(),
      );
    } finally {
      db.close();
    }
  }
  const content = await readFile(file, 'utf8');
  if (content.length > 10000000) throw new Error('导入文件不能超过 10 MB');
  return parseCCSwitch(JSON.parse(content));
}
