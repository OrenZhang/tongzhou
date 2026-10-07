import { describe, expect, it } from 'vitest';
import { providerUnavailableReason as reason } from '../../src/shared/provider-availability';
import type { Provider } from '../../src/shared/types';
const api: Provider = {
  id: 'one',
  name: 'one',
  protocol: 'openai-chat',
  baseUrl: 'https://example.test/v1',
  auth: 'api-key',
  models: [],
  maxOutputTokens: 8192,
  contextChars: 0,
};
describe('conversation connection availability', () => {
  it('requires credentials only when the connection needs them, without requiring a preloaded model catalog', () => {
    expect(reason(api)).toBe('尚未配置密钥');
    expect(reason({ ...api, hasSecret: true })).toBe('');
    expect(reason({ ...api, auth: 'none', models: ['local'] })).toBe('');
    expect(reason({ ...api, auth: 'none' })).toBe('尚未配置模型');
    expect(reason({ ...api, auth: 'none', enabled: true })).toBe('');
    expect(reason({ ...api, baseUrl: '', hasSecret: true })).toBe('尚未配置服务地址');
  });
  it('does not infer authorization from a model catalog; explicit disable wins over authorization', () => {
    for (const protocol of ['codex', 'kimi', 'minimax'] as const) {
      const provider = {
        ...api,
        protocol,
        auth: protocol === 'codex' ? ('chatgpt' as const) : ('native' as const),
        models: ['listed-model'],
      };
      expect(reason(provider)).toBe('正在检查授权');
      expect(reason(provider, { connected: false, pending: false, error: false })).toBe('尚未授权');
      expect(reason(provider, { connected: false, pending: true, error: false })).toBe(
        '等待授权完成',
      );
      expect(reason(provider, { connected: true, pending: false, error: false })).toBe('');
      expect(
        reason({ ...provider, enabled: false }, { connected: true, pending: false, error: false }),
      ).toBe('已停用');
    }
  });
});
