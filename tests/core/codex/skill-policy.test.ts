import { describe, expect, it, vi } from 'vitest';
import { disableNativeSkill } from '../../../electron/core/codex/skill-policy';

describe('native skill policy initialization', () => {
  it('retries only the idempotent disable operation after a transient config persistence failure', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'failed to update skill settings: failed to persist config at fixture/config.toml',
        ),
      )
      .mockResolvedValue({});
    await disableNativeSkill({ request }, 'fixture/SKILL.md', new AbortController().signal);
    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls)
      expect(call).toEqual(['skills/config/write', { path: 'fixture/SKILL.md', enabled: false }]);
  });
  it('fails closed for permanent persistence errors and does not retry other failures', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error('failed to persist config at fixture/config.toml'));
    await expect(
      disableNativeSkill({ request }, 'fixture/SKILL.md', new AbortController().signal),
    ).rejects.toThrow('persist config');
    expect(request).toHaveBeenCalledTimes(4);
    request.mockReset().mockRejectedValue(new Error('unknown skill'));
    await expect(
      disableNativeSkill({ request }, 'fixture/SKILL.md', new AbortController().signal),
    ).rejects.toThrow('unknown skill');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('stops immediately when cancelled instead of continuing policy writes', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockImplementation(() => {
      controller.abort();
      throw new Error('failed to persist config at fixture/config.toml');
    });
    await expect(
      disableNativeSkill({ request }, 'fixture/SKILL.md', controller.signal),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
