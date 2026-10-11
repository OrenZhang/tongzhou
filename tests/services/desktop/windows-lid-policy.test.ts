import { describe, it, expect, vi } from 'vitest';
import {
  WindowsLidPolicy,
  type LidBackup,
} from '../../../electron/services/desktop/windows-lid-policy';

const first = '381b4222-f694-41f0-9685-ff5bb260df2e';
const second = 'a1841308-3541-4fab-bc81-f71556f20b4a';
function fixture() {
  let active = first,
    backups: LidBackup[] = [];
  const values = new Map([
    [first, { ac: 1, dc: 2 }],
    [second, { ac: 2, dc: 1 }],
  ]);
  const driver = {
    read: () => structuredClone(backups),
    write: (value: LidBackup[]) => {
      backups = structuredClone(value);
    },
    run: vi.fn(async (args: string[]) => {
      if (args[0] === '/getactivescheme') return `电源方案 GUID: ${active} (平衡)`;
      const value = values.get(args[1])!;
      if (args[0] === '/qh') return `交流 0x0000000${value.ac}\n直流 0x0000000${value.dc}`;
      if (args[0] === '/setacvalueindex') {
        expect(backups.some((backup) => backup.scheme === args[1])).toBe(true);
        value.ac = Number(args[4]);
      } else if (args[0] === '/setactive') active = args[1];
      else throw new Error('unexpected powercfg write');
      return '';
    }),
  };
  return {
    policy: new WindowsLidPolicy(driver),
    driver,
    values,
    setActive: (value: string) => {
      active = value;
    },
  };
}
describe('temporary Windows AC lid policy', () => {
  it('backs up before changing only AC and restores the original action', async () => {
    const { policy, values, driver } = fixture();
    await policy.enable();
    await policy.enable();
    expect(driver.read()).toEqual([{ scheme: first, ac: 1 }]);
    expect(values.get(first)).toEqual({ ac: 0, dc: 2 });
    await policy.restore();
    expect(values.get(first)).toEqual({ ac: 1, dc: 2 });
    expect(driver.read()).toEqual([]);
  });
  it('moves the override to a newly selected plan without reactivating the old one', async () => {
    const { policy, values, driver, setActive } = fixture();
    await policy.enable();
    setActive(second);
    await policy.enable();
    expect(values.get(first)?.ac).toBe(1);
    expect(values.get(second)).toEqual({ ac: 0, dc: 1 });
    expect(await policy.activeScheme()).toBe(second);
    expect(driver.read()).toEqual([{ scheme: second, ac: 2 }]);
    await policy.restore();
    expect(values.get(second)?.ac).toBe(2);
  });
  it('preserves settings modified by another application', async () => {
    const { policy, values } = fixture();
    await policy.enable();
    values.get(first)!.ac = 3;
    await expect(policy.enable()).rejects.toThrow('其他程序');
    await policy.restore();
    expect(values.get(first)?.ac).toBe(3);
  });
  it('keeps a failed write recoverable by a replacement helper', async () => {
    const { policy, driver, values } = fixture();
    const run = driver.run.getMockImplementation()!;
    driver.run.mockImplementation(async (args) => {
      const result = await run(args);
      if (args[0] === '/setacvalueindex') throw new Error('interrupted');
      return result;
    });
    await expect(policy.enable()).rejects.toThrow('interrupted');
    expect(driver.read()).toEqual([{ scheme: first, ac: 1 }]);
    driver.run.mockImplementation(run);
    await new WindowsLidPolicy(driver).restore();
    expect(values.get(first)?.ac).toBe(1);
  });
  it('leaves an already-disabled lid action unchanged', async () => {
    const { policy, values, driver } = fixture();
    values.get(first)!.ac = 0;
    await policy.enable();
    await policy.restore();
    expect(driver.read()).toEqual([]);
    expect(values.get(first)?.ac).toBe(0);
  });
});
