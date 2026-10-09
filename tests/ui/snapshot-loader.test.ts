import { describe, it, expect, vi } from 'vitest';
import { SnapshotLoader } from '../../src/lib/snapshot-loader';
import type { Snapshot, TaskSnapshot } from '../../src/shared/types';

const full: Snapshot = {
  providers: [],
  agents: [],
  projects: [],
  sessions: [],
  runs: [],
  approvals: [],
};
const tasks: TaskSnapshot = { sessions: [], runs: [], approvals: [] };
describe('scoped snapshot loading', () => {
  it('serializes task invalidation behind an in-flight full read without losing either', async () => {
    let finish!: (data: Snapshot) => void;
    const api = {
      snapshot: vi.fn(() => new Promise<Snapshot>((r) => (finish = r))),
      taskSnapshot: vi.fn(async () => tasks),
    };
    const applied: boolean[] = [];
    const loader = new SnapshotLoader(api, (_, full) => applied.push(full));
    const request = loader.load();
    void loader.load(false);
    void loader.load(false);
    expect(api.taskSnapshot).not.toHaveBeenCalled();
    finish(full);
    await request;
    expect(applied).toEqual([true, false]);
    expect(api.taskSnapshot).toHaveBeenCalledTimes(1);
  });
  it('does not fetch configuration for task changes or apply data after disposal', async () => {
    const api = { snapshot: vi.fn(async () => full), taskSnapshot: vi.fn(async () => tasks) };
    const apply = vi.fn();
    const loader = new SnapshotLoader(api, apply);
    await loader.load(false);
    expect(api.snapshot).not.toHaveBeenCalled();
    const pending = loader.load();
    loader.dispose();
    await pending;
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
