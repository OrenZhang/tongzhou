import {
  defaultPowerPreferences,
  type PowerPreferences,
  type PowerState,
} from '../../../src/shared/power';

export interface PowerDriver {
  supported: boolean;
  platform: string;
  onBatteryPower(): boolean;
  blockerActive?(id: number): boolean;
  startBlocker(): number | Promise<number>;
  stopBlocker(id: number): void | Promise<void>;
  setLidEnabled(enabled: boolean, interactive?: boolean): Promise<void>;
}

/** Owns only our power request; battery operation and display sleep stay under Windows control. */
export class PowerSettings {
  private preferences: PowerPreferences;
  private blocker?: number;
  private lidActive = false;
  private onBatteryPower: boolean;
  private error?: string;
  private closing = false;
  private pending = Promise.resolve();
  private starting?: Promise<void>;
  private releasing = Promise.resolve();

  constructor(
    private driver: PowerDriver,
    preferences: Partial<PowerPreferences>,
    private save: (value: PowerPreferences) => void,
    private changed: (state: PowerState) => void,
  ) {
    this.preferences = { ...defaultPowerPreferences, ...preferences };
    this.onBatteryPower = driver.onBatteryPower();
  }

  snapshot(): PowerState {
    return {
      ...this.preferences,
      supported: this.driver.supported,
      platform: this.driver.platform,
      onBatteryPower: this.onBatteryPower,
      active: this.blocker !== undefined,
      lidActive: this.lidActive,
      error: this.error,
    };
  }

  async set(value: PowerPreferences) {
    if (this.closing) throw new Error('应用正在退出');
    if (!this.driver.supported) throw new Error('此功能目前仅支持 Windows 和 macOS');
    this.onBatteryPower = this.driver.onBatteryPower();
    if (
      this.onBatteryPower &&
      ((!this.preferences.keepAwakeOnAC && value.keepAwakeOnAC) ||
        (!this.preferences.keepAwakeWhenLidClosed && value.keepAwakeWhenLidClosed))
    )
      throw new Error('请先连接电源，再启用保持唤醒');
    this.save(value);
    this.preferences = { ...value };
    await this.refresh(this.onBatteryPower, true);
    return this.snapshot();
  }

  refresh(onBatteryPower = this.driver.onBatteryPower(), interactive = false) {
    this.onBatteryPower = onBatteryPower;
    // Release synchronously on unplug, even if a Windows policy operation is still pending.
    const syncing = this.syncBlocker();
    void syncing.catch(() => {});
    const work = this.pending.then(async () => {
      try {
        await syncing;
        await this.syncBlocker();
        const enabled = this.blocker !== undefined && this.preferences.keepAwakeWhenLidClosed;
        await this.driver.setLidEnabled(enabled, interactive);
        this.lidActive = enabled;
        this.error = undefined;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
      this.changed(this.snapshot());
    });
    this.pending = work.catch(() => {});
    return work;
  }

  reportLidError(message: string) {
    this.lidActive = false;
    this.error = message;
    this.changed(this.snapshot());
  }

  private shouldBlock() {
    return (
      this.driver.supported &&
      !this.closing &&
      this.preferences.keepAwakeOnAC &&
      !this.onBatteryPower
    );
  }
  private syncBlocker(): Promise<void> {
    if (this.blocker !== undefined && this.driver.blockerActive?.(this.blocker) === false)
      this.blocker = undefined;
    if (!this.shouldBlock() && this.blocker !== undefined) {
      const id = this.blocker;
      this.blocker = undefined;
      this.releasing = Promise.resolve(this.driver.stopBlocker(id));
    } else if (this.shouldBlock() && this.blocker === undefined && !this.starting) {
      try {
        const result = this.driver.startBlocker();
        if (typeof result === 'number') this.blocker = result;
        else
          this.starting = result
            .then(async (id) => {
              if (this.shouldBlock()) this.blocker = id;
              else await this.driver.stopBlocker(id);
            })
            .finally(() => {
              this.starting = undefined;
            });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return Promise.all([this.starting, this.releasing]).then(() => {});
  }

  async dispose() {
    this.closing = true;
    await this.refresh();
    if (this.error) throw new Error(this.error);
  }
}
