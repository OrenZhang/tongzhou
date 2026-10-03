import { useEffect, useState } from 'react';
import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';
import {
  defaultAppearance,
  normalizeAppearance,
  type AppearancePreferences,
  type Theme,
} from './shared/appearance';
const key = 'tongzhou-appearance';
export function savedAppearance(): AppearancePreferences {
  try {
    const legacy = localStorage.getItem('tongzhou-theme');
    try {
      return normalizeAppearance(JSON.parse(localStorage.getItem(key) ?? 'null'), legacy);
    } catch {
      return normalizeAppearance(null, legacy);
    }
  } catch {
    return { ...defaultAppearance };
  }
}
export function applyTheme(value: Theme) {
  document.documentElement.dataset.theme =
    value === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : value;
}
export function applyAppearance(value: AppearancePreferences) {
  applyTheme(value.theme);
  document.documentElement.dataset.style = value.style;
  document.documentElement.dataset.font = value.font;
  document.documentElement.style.setProperty('--chat-font-size', value.textSize + 'px');
}
export function useAppearance() {
  const [appearance, setAppearanceState] = useState(savedAppearance);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(appearance));
      localStorage.setItem('tongzhou-theme', appearance.theme);
    } catch {
      /* Keep this window usable if local storage is unavailable. */
    }
    applyAppearance(appearance);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(appearance.theme);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [appearance]);
  useEffect(() => {
    let live = true;
    let received = false;
    const api = window.tongzhou;
    const off = api?.onEvent((event) => {
      if (event.type === 'appearance') {
        received = true;
        setAppearanceState((old) => normalizeAppearance({ ...old, ...event.value }));
      }
    });
    void api
      ?.getAppearance()
      .then((value) => {
        if (live && !received)
          setAppearanceState((old) => normalizeAppearance({ ...old, ...value }));
      })
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, []);
  const setAppearance = (value: AppearancePreferences) => {
    setAppearanceState(value);
    void window.tongzhou?.setAppearance(value).catch(() => {});
  };
  return { appearance, setAppearance };
}
const styles = [
  { id: 'graphite', name: '石墨', description: '中性灰阶，专注内容' },
  { id: 'blue', name: '雾蓝', description: '清爽冷调，柔和强调' },
  { id: 'sand', name: '暖砂', description: '纸感暖色，舒适阅读' },
] as const;
export function Appearance({
  value,
  onChange,
}: {
  value: AppearancePreferences;
  onChange: (t: AppearancePreferences) => void;
}) {
  return (
    <section className="settings-card appearance-card">
      <div className="settings-card-title">
        <Palette size={21} />
        <div>
          <h3>外观与字体</h3>
          <p>选一个喜欢的工作空间。修改立即生效，重启后保留。</p>
        </div>
      </div>
      <div className="appearance-layout">
        <div className="appearance-controls">
          <div className="appearance-control">
            <h4>界面风格</h4>
            <div className="style-options" aria-label="界面风格">
              {styles.map((style) => (
                <button
                  key={style.id}
                  className="style-option"
                  aria-label={style.name}
                  aria-pressed={value.style === style.id}
                  onClick={() => onChange({ ...value, style: style.id })}
                >
                  <span className="style-swatch" data-swatch={style.id} aria-hidden="true">
                    <i />
                    <span>
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                  <span className="style-name">
                    {style.name}
                    {value.style === style.id && <Check size={13} />}
                  </span>
                  <small>{style.description}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="appearance-control">
            <h4>明暗模式</h4>
            <div className="theme-options" aria-label="主题">
              {(['light', 'dark', 'system'] as const).map((t, i) => {
                const Icon = [Sun, Moon, Monitor][i];
                return (
                  <button
                    key={t}
                    className={value.theme === t ? 'active' : ''}
                    aria-pressed={value.theme === t}
                    onClick={() => onChange({ ...value, theme: t })}
                  >
                    <Icon size={15} />
                    {['浅色', '深色', '跟随系统'][i]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="appearance-typography">
            <label>
              界面字体
              <select
                aria-label="界面字体"
                value={value.font}
                onChange={(e) =>
                  onChange({ ...value, font: e.target.value as AppearancePreferences['font'] })
                }
              >
                <option value="modern">现代黑体</option>
                <option value="system">系统字体</option>
                <option value="serif">书籍宋体</option>
              </select>
            </label>
            <label>
              聊天字号
              <select
                aria-label="聊天字号"
                value={value.textSize}
                onChange={(e) =>
                  onChange({
                    ...value,
                    textSize: Number(e.target.value) as AppearancePreferences['textSize'],
                  })
                }
              >
                <option value="14">紧凑 · 14</option>
                <option value="16">标准 · 16</option>
                <option value="18">大字 · 18</option>
              </select>
            </label>
          </div>
          <p className="appearance-hint">
            使用本机字体：黑体优先思源 / 苹方 / 微软雅黑，宋体优先思源宋体 /
            系统宋体。缺少时自动回退，代码保持等宽。
          </p>
        </div>
        <div className="appearance-preview" aria-label="外观预览">
          <div className="preview-title">
            <span className="preview-dot" />
            同舟<span>预览</span>
          </div>
          <div className="preview-body">
            <small>你的工作空间</small>
            <h4>让想法，顺畅发生。</h4>
            <p>
              文字清楚，操作轻巧。
              <br />
              在同一会话中，完成每一步。
            </p>
            <code>const idea = 'Hello, 同舟';</code>
            <div className="preview-input">
              输入消息…<span>↑</span>
            </div>
          </div>
        </div>
      </div>
      <div className="appearance-footer">
        <span>风格、明暗与字体可以自由组合。</span>
        <button className="text-button" onClick={() => onChange({ ...defaultAppearance })}>
          恢复默认外观
        </button>
      </div>
    </section>
  );
}
