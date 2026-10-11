export interface LidBackup {
  scheme: string;
  ac: number;
}
export interface LidPolicyDriver {
  run(args: string[]): Promise<string>;
  read(): LidBackup[];
  write(backups: LidBackup[]): void;
}
const guid = /[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}/i;

/** Only AC LIDACTION is changed. Save before writing so interruption can be recovered. */
export class WindowsLidPolicy {
  constructor(private driver: LidPolicyDriver) {}

  async activeScheme() {
    const result = await this.driver.run(['/getactivescheme']);
    const scheme = result.match(guid)?.[0];
    if (!scheme) throw new Error('无法读取当前 Windows 电源计划');
    return scheme.toLowerCase();
  }

  async readAC(scheme: string) {
    // /qh includes hidden settings. Hexadecimal indices avoid localized field names.
    const result = await this.driver.run(['/qh', scheme, 'SUB_BUTTONS', 'LIDACTION']);
    const indices = result.match(/0x[\da-f]+/gi);
    if (indices?.length !== 2) throw new Error('此设备未提供可管理的合盖电源设置');
    const ac = Number.parseInt(indices[0], 16);
    if (![0, 1, 2, 3].includes(ac)) throw new Error('无法识别 Windows 合盖动作');
    return ac;
  }

  private async setAC(scheme: string, value: number) {
    await this.driver.run(['/setacvalueindex', scheme, 'SUB_BUTTONS', 'LIDACTION', String(value)]);
    // Never reactivate an old plan if the user changed plans in the meantime.
    if ((await this.activeScheme()) === scheme) await this.driver.run(['/setactive', scheme]);
  }

  async enable() {
    const scheme = await this.activeScheme();
    const backups = this.driver.read();
    if (backups.some((backup) => backup.scheme !== scheme)) await this.restore();
    const ac = await this.readAC(scheme);
    const saved = this.driver.read();
    if (saved.some((backup) => backup.scheme === scheme)) {
      if (ac !== 0) throw new Error('系统合盖设置已被其他程序修改，请关闭并重新启用此选项');
      return;
    }
    if (ac === 0) return;
    this.driver.write([...saved, { scheme, ac }]);
    await this.setAC(scheme, 0);
    if ((await this.readAC(scheme)) !== 0)
      throw new Error('Windows 未应用合盖设置，请检查系统策略');
  }

  async restore() {
    for (const backup of this.driver.read()) {
      const current = await this.readAC(backup.scheme);
      // Do not overwrite a later change made by the user or another program.
      if (current === 0) {
        await this.setAC(backup.scheme, backup.ac);
        if ((await this.readAC(backup.scheme)) !== backup.ac)
          throw new Error('Windows 合盖设置尚未恢复，请重试');
      }
      this.driver.write(this.driver.read().filter((item) => item.scheme !== backup.scheme));
    }
  }
}
