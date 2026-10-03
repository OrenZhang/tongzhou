import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
export type Theme = 'system' | 'light' | 'dark';
const key = 'tongzhou-theme';
export function savedTheme(): Theme {
  const value = localStorage.getItem(key);
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function applyTheme(value: Theme) {
  document.documentElement.dataset.theme =
    value === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : value;
}
export function useAppearance() {
  const [theme, setTheme] = useState(savedTheme);
  useEffect(() => {
    localStorage.setItem(key, theme);
    applyTheme(theme);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(theme);
    media.addEventListener('change', update);
    void window.tongzhou?.setTheme(theme).catch(() => {});
    return () => media.removeEventListener('change', update);
  }, [theme]);
  return { theme, setTheme };
}
export function Appearance({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <section className="settings-card">
      <div className="settings-card-title">
        <Monitor size={22} />
        <div>
          <h3>外观</h3>
          <p>浅色、深色或跟随系统，立即应用并保存。</p>
        </div>
      </div>
      <div className="theme-options" aria-label="主题">
        {(['light', 'dark', 'system'] as const).map((t, i) => {
          const Icon = [Sun, Moon, Monitor][i];
          return (
            <button
              key={t}
              className={value === t ? 'active' : ''}
              aria-pressed={value === t}
              onClick={() => onChange(t)}
            >
              <Icon size={18} />
              {['浅色', '深色', '跟随系统'][i]}
            </button>
          );
        })}
      </div>
    </section>
  );
}
