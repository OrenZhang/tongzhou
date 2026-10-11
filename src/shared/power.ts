export interface PowerPreferences {
  keepAwakeOnAC: boolean;
  keepAwakeWhenLidClosed: boolean;
}

export interface PowerState extends PowerPreferences {
  supported: boolean;
  platform: string;
  onBatteryPower: boolean;
  active: boolean;
  lidActive: boolean;
  error?: string;
}

export const defaultPowerPreferences: PowerPreferences = {
  keepAwakeOnAC: false,
  keepAwakeWhenLidClosed: false,
};
