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

/** 文字の大きさ。auto は端末に合わせる（スマホは「大」、パソコンは「標準」） */
export type FontChoice = 'auto' | 'standard' | 'large' | 'xlarge';
export const FONT_CHOICES: Exclude<FontChoice, 'auto'>[] = ['standard', 'large', 'xlarge'];
export const FONT_LABEL: Record<FontChoice, string> = { auto: '自動', standard: '標準', large: '大', xlarge: '特大' };

const FONT_KEY = 'lcm-font';

export function getFont(): FontChoice {
  try {
    const v = localStorage.getItem(FONT_KEY);
    return v === 'standard' || v === 'large' || v === 'xlarge' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** いま実際に使っている大きさ（auto のときは画面の幅で決まる） */
export function resolveFont(choice: FontChoice): Exclude<FontChoice, 'auto'> {
  if (choice !== 'auto') return choice;
  try {
    return window.matchMedia('(max-width: 767px)').matches ? 'large' : 'standard';
  } catch {
    return 'standard';
  }
}

export function applyFont(choice: FontChoice) {
  // auto のときは属性を付けない（CSS が画面の幅で決める）
  if (choice === 'auto') delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = choice;
}

export function setFont(choice: FontChoice) {
  try {
    if (choice === 'auto') localStorage.removeItem(FONT_KEY);
    else localStorage.setItem(FONT_KEY, choice);
  } catch {
    // 保存できなくても、その場の表示は切り替える
  }
  applyFont(choice);
  window.dispatchEvent(new CustomEvent('lcm-font', { detail: choice }));
}

/** 文字の大きさの選択と切り替え。画面の幅が変わったとき（auto）も表示を追いかける */
export function useFont(): [Exclude<FontChoice, 'auto'>, (c: FontChoice) => void] {
  const [choice, setChoice] = useState<FontChoice>(getFont);
  const [, rerender] = useState(0);
  useEffect(() => {
    const onChange = () => setChoice(getFont());
    window.addEventListener('lcm-font', onChange);
    const mq = window.matchMedia('(max-width: 767px)');
    const onWidth = () => rerender((n) => n + 1);
    mq.addEventListener('change', onWidth);
    return () => {
      window.removeEventListener('lcm-font', onChange);
      mq.removeEventListener('change', onWidth);
    };
  }, []);
  return [resolveFont(choice), setFont];
}
