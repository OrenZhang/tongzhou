export type Theme = 'system' | 'light' | 'dark';
export type AppearanceStyle = 'graphite' | 'blue' | 'sand';
export type InterfaceFont = 'modern' | 'system' | 'serif';
export interface AppearancePreferences {
  theme: Theme;
  style: AppearanceStyle;
  font: InterfaceFont;
  textSize: 14 | 16 | 18;
}
export const defaultAppearance: AppearancePreferences = {
  theme: 'system',
  style: 'graphite',
  font: 'system',
  textSize: 14,
};
export function normalizeAppearance(raw: unknown): AppearancePreferences {
  const value = raw && typeof raw === 'object' ? (raw as Partial<AppearancePreferences>) : {};
  const theme = value.theme;
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    style: value.style === 'blue' || value.style === 'sand' ? value.style : 'graphite',
    font: value.font === 'modern' || value.font === 'serif' ? value.font : 'system',
    textSize: value.textSize === 16 || value.textSize === 18 ? value.textSize : 14,
  };
}
