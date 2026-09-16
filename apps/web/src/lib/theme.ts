import { useEffect, useState } from 'react';

/** 表示テーマ。auto は端末の設定（昼／夜）に合わせる */
export type ThemeChoice = 'auto' | 'light' | 'dark';
export const THEME_CHOICES: ThemeChoice[] = ['auto', 'light', 'dark'];
export const THEME_LABEL: Record<ThemeChoice, string> = { auto: '端末に合わせる', light: '昼', dark: '夜' };

const KEY = 'lcm-theme';

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** 実際に使う配色（auto のときは端末の設定を見る） */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'auto') return choice;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(choice: ThemeChoice) {
  const mode = resolveTheme(choice);
  document.documentElement.dataset.theme = mode;
  // アドレスバーの色も合わせる
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'dark' ? '#0e141b' : '#f4f2ee');
}

export function setTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // 保存できなくても、その場の表示は切り替える
  }
  applyTheme(choice);
  window.dispatchEvent(new CustomEvent('lcm-theme', { detail: choice }));
}

/** テーマの選択と切り替え。端末の設定が変わったときも追いかける */
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(getTheme);
  useEffect(() => {
    const onChange = () => setChoice(getTheme());
    window.addEventListener('lcm-theme', onChange);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystem = () => {
      if (getTheme() === 'auto') applyTheme('auto');
    };
    mq.addEventListener('change', onSystem);
    return () => {
      window.removeEventListener('lcm-theme', onChange);
      mq.removeEventListener('change', onSystem);
    };
  }, []);
  return [choice, setTheme];
}
